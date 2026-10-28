// Preserve native worker fixture mocks before production consumers load the registry.
// oxfmt-ignore
import {
  useSubagentControlFixture,
} from "../../agents/subagents/registry/subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createRequesterYieldCallback } from "../../agents/openclaw-tools.requester-yield.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as registryPersistence from "../../agents/subagents/registry/subagent-registry-persistence.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { revokeRequesterCronAuthority } from "../../agents/subagents/requester-cron-authority.js";
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import * as sessionSharing from "../session-sharing-preparation.js";
import { withRequesterTestAuthority } from "./sessions-initial-transfer.test-support.js";
import { sessionSharingTestContext } from "./sessions-sharing.test-support.js";

const fixture = useSubagentControlFixture();
const requesterSessionKey = "agent:main:main";
afterEach(() => {
  revokeRequesterCronAuthority(requesterSessionKey);
  vi.useRealTimers();
});

function yieldTool(requesterTurnRunId: string) {
  const onYield = vi.fn();
  return {
    onYield,
    tool: createSessionsYieldTool({
      sessionId: `${requesterSessionKey}-session`,
      onYield,
      claimYield: createRequesterYieldCallback({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
      }),
    }),
  };
}

function observeCommits(
  onCommit: (writes: number) => void | Promise<void> = () => {},
  phase: "before" | "after" = "after",
) {
  let writes = 0;
  fixture.interceptWorkerCommand((command) => {
    if (command.type === "subagents.persistChanges") {
      return onCommit(++writes);
    }
  }, phase);
  return {
    spy: fixture.worker,
    get writes() {
      return writes;
    },
  };
}

function holdCommit() {
  const entered = createDeferred();
  const release = createDeferred();
  const worker = observeCommits(async (writes) => {
    if (writes === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  return { worker, entered, release };
}

async function waitForHold(pending: Promise<unknown>, held: Promise<unknown>, message: string) {
  await awaitGateBeforeSettlement(held, pending, message);
}

function registerChild(
  runId: string,
  requesterTurnRunId: string,
  sessionEntry: Parameters<typeof registerSubagentRun>[0]["sessionEntry"] = {
    sessionId: `${runId}-session`,
  },
) {
  return registerSubagentRun({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    childAgentId: "main",
    sessionEntry,
    requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId,
    requesterDisplayKey: requesterSessionKey,
    task: "Retain the original session source",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
}

function writeRequester(sessionKey = requesterSessionKey, lifecycleRevision = "original") {
  return writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: `${sessionKey}-session`,
    lifecycleRevision,
  });
}

async function createYieldedChild(withSibling = false) {
  const requesterTurnRunId = "staged-cohort-parent";
  const runId = "staged-cohort-child";
  const childSessionKey = "agent:main:subagent:staged-cohort-child";
  const children = [{ runId, childSessionKey, expectsCompletionMessage: true }];
  if (withSibling) {
    children.push({
      runId: `${runId}-sibling`,
      childSessionKey: `${childSessionKey}-sibling`,
      expectsCompletionMessage: true,
    });
  }
  for (const sessionKey of [
    requesterSessionKey,
    ...children.map((child) => child.childSessionKey),
  ]) {
    await writeRequester(sessionKey, "initial-transfer");
  }
  for (const child of children) {
    await registerChild(
      child.runId,
      requesterTurnRunId,
      loadSessionEntry({ agentId: "main", sessionKey: child.childSessionKey }),
    );
  }
  const nativePersistence = await vi.importActual<typeof registryPersistence>(
    "../../agents/subagents/registry/subagent-registry-persistence.js",
  );
  const { onYield, tool } = yieldTool(requesterTurnRunId);
  await expect(tool.execute("yield-cohort", {})).resolves.toMatchObject({
    details: { status: "yielded" },
  });
  return {
    entry: expectDefined(subagentRuns.get(runId), "original cohort child"),
    entries: children.map((child) => expectDefined(subagentRuns.get(child.runId), "cohort member")),
    nativePersistence,
    onYield,
    settle: (requesterYielded = true) =>
      settleRequesterAfterSessionSpawns({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
        requesterYielded,
        acceptedSessionSpawns: children,
      }),
  };
}

it.each(["unchanged", "empty"] as const)(
  "retains the original session source through cold registry restore (%s)",
  async (mode) => {
    const requesterTurnRunId = "cold-initial-parent";
    const runId = "cold-initial-child";
    const storePath = await writeRequester();
    const physicalPath = resolvePhysicalSessionStorePath({
      storePath,
      sessionKey: requesterSessionKey,
      agentId: "main",
    });
    await closeOpenClawAgentDatabaseByPathAsync(physicalPath, "main");
    if (mode !== "empty") {
      await registerChild(runId, requesterTurnRunId);
    }
    await resetSubagentRegistryForTests({ persist: false });
    await closeOpenClawStateDatabaseAsync();
    const restoreEntered = createDeferred();
    const releaseRestore = createDeferred();
    const restore = registryPersistence.restoreSubagentRunsFromDisk;
    const restoreSpy = vi
      .spyOn(registryPersistence, "restoreSubagentRunsFromDisk")
      .mockImplementation(async (...args) => {
        const result = await restore(...args);
        restoreEntered.resolve();
        await releaseRestore.promise;
        return result;
      });
    const preparations = vi.spyOn(sessionSharing, "prepareSessionMutationFacts");
    const { onYield, tool } = yieldTool(requesterTurnRunId);
    const hostSql = observeParentSqlite();
    try {
      await withRequesterTestAuthority(requesterTurnRunId, requesterSessionKey, async () => {
        const yielding = tool.execute("yield-cold-source", {}).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await waitForHold(
            yielding,
            restoreEntered.promise,
            "Yield bypassed the held canonical restore",
          );
          const facts = await Promise.all(
            preparations.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value] : [],
            ),
          );
          const releases = facts.map((read) => vi.spyOn(read, "release"));
          releaseRestore.resolve();
          const outcome = await yielding;
          if (mode === "empty") {
            expect(outcome).toMatchObject({ result: { details: { status: "nothing_pending" } } });
            expect(onYield).not.toHaveBeenCalled();
          } else {
            expect(outcome).toMatchObject({ result: { details: { status: "yielded" } } });
            expect(onYield).toHaveBeenCalledOnce();
            expect(
              expectDefined(subagentRuns.get(runId), "restored original child")
                .requesterTurnYielded,
            ).toBe(true);
          }
          revokeRequesterCronAuthority(requesterSessionKey);
          expect(facts).toHaveLength(1);
          for (const release of releases) {
            expect(release).toHaveBeenCalled();
          }
        } finally {
          releaseRestore.resolve();
          await yielding;
        }
      });
    } finally {
      hostSql.restore();
      preparations.mockRestore();
      restoreSpy.mockRestore();
    }
    expect(hostSql.counts).toEqual(emptySqliteCounts());
  },
);

it.each(["source retirement", "transport failure after commit"] as const)(
  "never repeats the acknowledged cohort commit after its %s result",
  async (outcome) => {
    vi.useFakeTimers();
    const { entry, settle, nativePersistence } = await createYieldedChild();
    let closing: Promise<void> | undefined;
    const worker = observeCommits((writes) => {
      if (writes !== 1) {
        return;
      }
      if (outcome === "transport failure after commit") {
        throw new SqliteWorkerError("cohort release acknowledgement lost", "outcome-unknown");
      }
      closing = closeOpenClawStateDatabaseAsync();
    });
    try {
      if (outcome === "source retirement") {
        await expect(settle()).rejects.toMatchObject({
          outcome: "committed",
          publication: "superseded",
        });
        expect(subagentRuns.get(entry.runId)?.requesterTurnRunId).toBe("staged-cohort-parent");
      } else {
        await expect(settle()).resolves.toBe(true);
        expect(subagentRuns.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
      }
      expect(worker.writes).toBe(1);
      expect(fixture.wake).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(worker.writes).toBe(1);
      expect(fixture.wake).not.toHaveBeenCalled();
      await closing;
      await closeOpenClawStateDatabaseAsync();
      await nativePersistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
      const restored = expectDefined(subagentRuns.get(entry.runId), "released durable cohort");
      expect(restored).not.toBe(entry);
      expect(restored.requesterTurnRunId).toBeUndefined();
      expect(restored.requesterTurnYielded).toBeUndefined();
      expect(restored.requesterSettleWake?.rearmGeneration).toBe(1);
      expect(worker.writes).toBe(1);
    } finally {
      await closing;
      worker.spy.mockRestore();
    }
  },
);

it("recovers an untransferred requester cohort after restart in one write", async () => {
  vi.useFakeTimers();
  const { entries } = await createYieldedChild(true);
  const worker = observeCommits(undefined, "before");
  try {
    await resetSubagentRegistryForTests({ persist: false });
    await closeOpenClawStateDatabaseAsync();
    await initSubagentRegistry();
    const restored = expectDefined(subagentRuns.get(entries[0]!.runId), "restored cohort");
    expect(restored).not.toBe(entries[0]);
    expect(restored.requesterTurnRunId).toBe("staged-cohort-parent");
    expect(restored.requesterSettleWake).toBeUndefined();
    const context = sessionSharingTestContext(vi.fn(), getRuntimeConfig());
    context.resolveGatewayContext = () => context;
    await activateSubagentRegistry(context.resolveGatewayContext).settled;
    expect(subagentRuns.get(restored.runId)?.requesterTurnRunId).toBeUndefined();
    expect(subagentRuns.get(restored.runId)?.requesterTurnYielded).toBeUndefined();
    expect(subagentRuns.get(restored.runId)?.requesterSettleWake).toMatchObject({
      batchRunIds: entries.map((entry) => entry.runId).toSorted(),
      rearmGeneration: 1,
    });
    expect(worker.writes).toBe(1);
    expect(fixture.wake).not.toHaveBeenCalled();
  } finally {
    await resetSubagentRegistryForTests({ persist: false });
    worker.spy.mockRestore();
  }
});

it.each([false, true])(
  "does not acknowledge the opposite settlement while a cohort write is pending (yielded: %s)",
  async (requesterYielded) => {
    const { entry, settle } = await createYieldedChild();
    const { worker, entered: acknowledged, release: releaseAcknowledgement } = holdCommit();
    const first = settle(requesterYielded);
    void first.catch(() => {});
    let opposite: Promise<boolean> | undefined;
    try {
      await waitForHold(first, acknowledged.promise, "Cohort skipped its held acknowledgement");
      opposite = settle(!requesterYielded);
      void opposite.catch(() => {});
      await vi.dynamicImportSettled();
      releaseAcknowledgement.resolve();
      await expect(first).resolves.toBe(true);
      await expect(opposite).rejects.toThrow("Another requester transfer is already pending");
      expect(worker.writes).toBe(1);
      const { loadSubagentRegistryFromSqlite } = await vi.importActual<
        typeof import("../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js")
      >("../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js");
      const stored = expectDefined(
        loadSubagentRegistryFromSqlite().get(entry.runId),
        "settled child",
      );
      expect(stored.requesterTurnRunId).toBeUndefined();
      expect(stored.requesterSettleWake?.requesterYieldBatch === true).toBe(requesterYielded);
      expect(fixture.wake).not.toHaveBeenCalled();
    } finally {
      releaseAcknowledgement.resolve();
      await Promise.allSettled([first, ...(opposite ? [opposite] : [])]);
      worker.spy.mockRestore();
    }
  },
);

it("releases cohort custody after a failed transfer so its caller can retry", async () => {
  const { entry, settle } = await createYieldedChild();
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockRejectedValueOnce(new Error("requester transfer worker unavailable"));
  try {
    await expect(settle()).rejects.toThrow("requester transfer worker unavailable");
    expect(subagentRuns.get(entry.runId)?.requesterTurnRunId).toBe("staged-cohort-parent");
  } finally {
    worker.mockRestore();
  }
  await expect(settle()).resolves.toBe(true);
  expect(subagentRuns.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
});

it("rejects an overlapping claim without releasing the first authority preparation", async () => {
  const requesterTurnRunId = "joined-authority-parent";
  const runId = "joined-authority-child";
  await writeRequester();
  await registerChild(runId, requesterTurnRunId);
  type Facts = Awaited<ReturnType<typeof sessionSharing.prepareSessionMutationFacts>>;
  const acceptedFacts: Facts[] = [];
  const secondRead = createDeferred();
  const releaseSecondRead = createDeferred();
  const prepare = sessionSharing.prepareSessionMutationFacts;
  let reads = 0;
  const preparation = vi
    .spyOn(sessionSharing, "prepareSessionMutationFacts")
    .mockImplementation((...args) => {
      const index = reads++;
      return prepare(...args).then(async (facts) => {
        acceptedFacts[index] = facts;
        if (index === 1) {
          secondRead.resolve();
          await releaseSecondRead.promise;
        }
        return facts;
      });
    });
  const { worker, entered: acknowledged, release: releaseAcknowledgement } = holdCommit();
  try {
    await withRequesterTestAuthority(requesterTurnRunId, requesterSessionKey, async () => {
      const { onYield, tool } = yieldTool(requesterTurnRunId);
      const first = tool.execute("first-authority-yield", {});
      void first.catch(() => {});
      let second: ReturnType<typeof tool.execute> | undefined;
      let secondSettled = false;
      try {
        await waitForHold(
          first,
          acknowledged.promise,
          "Initial intent skipped its held acknowledgement",
        );
        second = tool.execute("joined-authority-yield", {}).finally(() => {
          secondSettled = true;
        });
        void second.catch(() => {});
        await secondRead.promise;
        const releases = acceptedFacts.map((facts) => vi.spyOn(facts, "release"));
        releaseAcknowledgement.resolve();
        await expect(first).resolves.toMatchObject({ details: { status: "yielded" } });
        await vi.dynamicImportSettled();
        expect(secondSettled).toBe(false);
        expect(onYield).toHaveBeenCalledOnce();
        releaseSecondRead.resolve();
        await expect(second).rejects.toThrow("Another requester transfer is already pending");
        expect(worker.writes).toBe(1);
        expect(reads).toBe(2);
        expect(onYield).toHaveBeenCalledOnce();
        expect(releases[0]).not.toHaveBeenCalled();
        expect(releases[1]).toHaveBeenCalledOnce();
        revokeRequesterCronAuthority(requesterSessionKey);
        for (const release of releases) {
          expect(release).toHaveBeenCalledOnce();
        }
      } finally {
        releaseAcknowledgement.resolve();
        releaseSecondRead.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        revokeRequesterCronAuthority(requesterSessionKey);
      }
    });
  } finally {
    preparation.mockRestore();
    worker.spy.mockRestore();
  }
});
