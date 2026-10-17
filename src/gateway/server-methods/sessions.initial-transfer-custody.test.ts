// Preserve native worker fixture mocks before production consumers load the registry.
// oxfmt-ignore
import {
  runSubagentStateWorkerOperation,
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
  const tool = createSessionsYieldTool({
    sessionId: `${requesterSessionKey}-session`,
    onYield,
    claimYield: createRequesterYieldCallback({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
    }),
  });
  return { tool, onYield };
}

function writeSession(sessionKey = requesterSessionKey, lifecycleRevision = "original") {
  return writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: `${sessionKey}-session`,
    lifecycleRevision,
  });
}

function registerChild(
  requesterTurnRunId: string,
  runId: string,
  sessionEntry = { sessionId: `${runId}-session` },
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
    task: "Finish the acknowledged cohort handoff",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
}

function pauseGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    hold: () => {
      entered.resolve();
      return release.promise;
    },
  };
}

function observeCohortWrites(onFirstCommit?: () => void | Promise<void>) {
  const counter = { writes: 0 };
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    (context, operation, options) =>
      runSubagentStateWorkerOperation(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: async (...args) => {
              const result = await scope.execute(...args);
              if (args[0].type === "subagents.persistChanges" && ++counter.writes === 1) {
                const pending = onFirstCommit?.();
                if (pending) {
                  await pending;
                }
              }
              return result;
            },
          }),
        options,
      ),
  );
  return counter;
}

async function createYieldedChild(withSibling = false) {
  const requesterTurnRunId = "staged-cohort-parent";
  const runId = "staged-cohort-child";
  const children = (withSibling ? [runId, `${runId}-sibling`] : [runId]).map((childRunId) => ({
    runId: childRunId,
    childSessionKey: `agent:main:subagent:${childRunId}`,
    expectsCompletionMessage: true,
  }));
  for (const sessionKey of [
    requesterSessionKey,
    ...children.map((child) => child.childSessionKey),
  ]) {
    await writeSession(sessionKey, "initial-transfer");
  }
  for (const child of children) {
    await registerChild(
      requesterTurnRunId,
      child.runId,
      expectDefined(
        loadSessionEntry({ agentId: "main", sessionKey: child.childSessionKey }),
        "cohort child session",
      ),
    );
  }
  const nativePersistence = await vi.importActual<typeof registryPersistence>(
    "../../agents/subagents/registry/subagent-registry-persistence.js",
  );
  const { tool } = yieldTool(requesterTurnRunId);
  await expect(tool.execute("yield-cohort", {})).resolves.toMatchObject({
    details: { status: "yielded" },
  });
  return {
    entry: expectDefined(subagentRuns.get(runId), "original cohort child"),
    entries: children.map((child) => expectDefined(subagentRuns.get(child.runId), "cohort member")),
    nativePersistence,
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
    const storePath = await writeSession();
    const physicalPath = resolvePhysicalSessionStorePath({
      storePath,
      sessionKey: requesterSessionKey,
      agentId: "main",
    });
    await closeOpenClawAgentDatabaseByPathAsync(physicalPath, "main");
    if (mode !== "empty") {
      await registerChild(requesterTurnRunId, runId);
    }
    await resetSubagentRegistryForTests({ persist: false });
    await closeOpenClawStateDatabaseAsync();
    const restoreGate = pauseGate();
    const restore = registryPersistence.restoreSubagentRunsFromDisk;
    vi.spyOn(registryPersistence, "restoreSubagentRunsFromDisk").mockImplementation(
      async (...args) => {
        const result = await restore(...args);
        await restoreGate.hold();
        return result;
      },
    );
    const preparations = vi.spyOn(sessionSharing, "prepareSessionMutationFacts");
    const { tool, onYield } = yieldTool(requesterTurnRunId);
    const hostSql = observeParentSqlite();
    try {
      await withRequesterTestAuthority(requesterTurnRunId, requesterSessionKey, async () => {
        const yielding = tool.execute("yield-cold-source", {}).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await awaitGateBeforeSettlement(
            restoreGate.entered,
            yielding,
            "Yield bypassed the held canonical restore",
          );
          const facts = await Promise.all(
            preparations.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value] : [],
            ),
          );
          const releases = facts.map((read) => vi.spyOn(read, "release"));
          restoreGate.release();
          const outcome = await yielding;
          if (mode === "empty") {
            expect(outcome).toMatchObject({ result: { details: { status: "nothing_pending" } } });
            expect(onYield).not.toHaveBeenCalled();
          } else {
            expect(outcome).toMatchObject({ result: { details: { status: "yielded" } } });
            expect(onYield).toHaveBeenCalledOnce();
            expect(subagentRuns.get(runId)).toMatchObject({ requesterTurnYielded: true });
          }
          revokeRequesterCronAuthority(requesterSessionKey);
          expect(facts).toHaveLength(1);
          for (const release of releases) {
            expect(release).toHaveBeenCalled();
          }
        } finally {
          restoreGate.release();
          await yielding;
        }
      });
    } finally {
      hostSql.restore();
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
    const counter = observeCohortWrites(() => {
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
      expect(counter.writes).toBe(1);
      expect(fixture.wake).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(counter.writes).toBe(1);
      expect(fixture.wake).not.toHaveBeenCalled();
      await closing;
      await closeOpenClawStateDatabaseAsync();
      await nativePersistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
      const restored = expectDefined(subagentRuns.get(entry.runId), "released durable cohort");
      expect(restored).not.toBe(entry);
      expect(restored.requesterTurnRunId).toBeUndefined();
      expect(restored.requesterTurnYielded).toBeUndefined();
      expect(restored.requesterSettleWake?.rearmGeneration).toBe(1);
      expect(counter.writes).toBe(1);
    } finally {
      await closing;
    }
  },
);

it("recovers an untransferred requester cohort after restart in one write", async () => {
  vi.useFakeTimers();
  const { entries } = await createYieldedChild(true);
  const counter = observeCohortWrites();
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
    await activateSubagentRegistry(context.resolveGatewayContext);
    const activated = subagentRuns.get(restored.runId);
    expect(activated?.requesterTurnRunId).toBeUndefined();
    expect(activated?.requesterTurnYielded).toBeUndefined();
    expect(activated?.requesterSettleWake).toMatchObject({
      batchRunIds: entries.map((entry) => entry.runId).toSorted(),
      rearmGeneration: 1,
    });
    expect(counter.writes).toBe(1);
    expect(fixture.wake).not.toHaveBeenCalled();
  } finally {
    await resetSubagentRegistryForTests({ persist: false });
  }
});

it.each([false, true])(
  "does not acknowledge the opposite settlement while a cohort write is pending (yielded: %s)",
  async (requesterYielded) => {
    const { entry, settle } = await createYieldedChild();
    const acknowledgement = pauseGate();
    const counter = observeCohortWrites(acknowledgement.hold);
    const first = settle(requesterYielded);
    void first.catch(() => {});
    let opposite: Promise<boolean> | undefined;
    try {
      await awaitGateBeforeSettlement(
        acknowledgement.entered,
        first,
        "Cohort skipped its held acknowledgement",
      );
      opposite = settle(!requesterYielded);
      void opposite.catch(() => {});
      await vi.dynamicImportSettled();
      acknowledgement.release();
      await expect(first).resolves.toBe(true);
      await expect(opposite).rejects.toThrow("Another requester transfer is already pending");
      expect(counter.writes).toBe(1);
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
      acknowledgement.release();
      await Promise.allSettled([first, ...(opposite ? [opposite] : [])]);
    }
  },
);

it("rejects an overlapping claim without releasing the first authority preparation", async () => {
  const requesterTurnRunId = "joined-authority-parent";
  const runId = "joined-authority-child";
  await writeSession();
  await registerChild(requesterTurnRunId, runId);
  type Facts = Awaited<ReturnType<typeof sessionSharing.prepareSessionMutationFacts>>;
  const acceptedFacts: Facts[] = [];
  const secondRead = pauseGate();
  const prepare = sessionSharing.prepareSessionMutationFacts;
  let reads = 0;
  vi.spyOn(sessionSharing, "prepareSessionMutationFacts").mockImplementation((...args) => {
    const index = reads++;
    return prepare(...args).then(async (facts) => {
      acceptedFacts[index] = facts;
      if (index === 1) {
        await secondRead.hold();
      }
      return facts;
    });
  });
  const acknowledgement = pauseGate();
  const counter = observeCohortWrites(acknowledgement.hold);
  await withRequesterTestAuthority(requesterTurnRunId, requesterSessionKey, async () => {
    const { tool, onYield } = yieldTool(requesterTurnRunId);
    const first = tool.execute("first-authority-yield", {});
    void first.catch(() => {});
    let second: ReturnType<typeof tool.execute> | undefined;
    let secondSettled = false;
    try {
      await awaitGateBeforeSettlement(
        acknowledgement.entered,
        first,
        "Initial intent skipped its held acknowledgement",
      );
      second = tool.execute("joined-authority-yield", {}).finally(() => {
        secondSettled = true;
      });
      void second.catch(() => {});
      await secondRead.entered;
      const releases = acceptedFacts.map((facts) => vi.spyOn(facts, "release"));
      acknowledgement.release();
      await expect(first).resolves.toMatchObject({ details: { status: "yielded" } });
      await vi.dynamicImportSettled();
      expect(secondSettled).toBe(false);
      expect(onYield).toHaveBeenCalledOnce();
      secondRead.release();
      await expect(second).rejects.toThrow("Another requester transfer is already pending");
      expect(counter.writes).toBe(1);
      expect(reads).toBe(2);
      expect(onYield).toHaveBeenCalledOnce();
      expect(releases.map((release) => release.mock.calls.length)).toEqual([0, 1]);
      revokeRequesterCronAuthority(requesterSessionKey);
      expect(releases.map((release) => release.mock.calls.length)).toEqual([1, 1]);
    } finally {
      acknowledgement.release();
      secondRead.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      revokeRequesterCronAuthority(requesterSessionKey);
    }
  });
});
