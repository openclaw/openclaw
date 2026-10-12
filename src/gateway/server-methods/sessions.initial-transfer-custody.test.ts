// Preserve native worker fixture mocks before production consumers load the registry.
// oxfmt-ignore
import {
  runSubagentStateWorkerOperation,
  useSubagentControlFixture,
} from "../../agents/subagents/registry/subagent-control.test-support.js";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: `${sessionKey}-session`,
    });
  }
  for (const child of children) {
    await registerSubagentRun({
      ...child,
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
      requesterDisplayKey: requesterSessionKey,
      task: "Finish the acknowledged cohort handoff",
      cleanup: "keep",
    });
  }
  const nativePersistence = await vi.importActual<typeof registryPersistence>(
    "../../agents/subagents/registry/subagent-registry-persistence.js",
  );
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

it.each(["unchanged", "replaced", "empty"] as const)(
  "retains the original session source through cold registry restore (%s)",
  async (mode) => {
    const requesterTurnRunId = "cold-initial-parent";
    const runId = "cold-initial-child";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: requesterSessionKey,
      defaultSessionId: `${requesterSessionKey}-session`,
      lifecycleRevision: "original",
    });
    const physicalPath = resolvePhysicalSessionStorePath({
      storePath,
      sessionKey: requesterSessionKey,
      agentId: "main",
    });
    await closeOpenClawAgentDatabaseByPathAsync(physicalPath, "main");
    const originalBytes = await fs.readFile(physicalPath);
    const replacement = `${physicalPath}.initial-transfer-replacement`;
    if (mode === "replaced") {
      await fs.writeFile(replacement, originalBytes);
    }
    if (mode !== "empty") {
      await registerSubagentRun({
        runId,
        childSessionKey: "agent:main:subagent:cold-initial-child",
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
        requesterDisplayKey: requesterSessionKey,
        task: "Retain the original session source",
        cleanup: "keep",
        expectsCompletionMessage: true,
      });
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
    const hostSql = observeParentSqlite();
    try {
      await withRequesterTestAuthority(requesterTurnRunId, requesterSessionKey, async () => {
        const yielding = tool.execute("yield-cold-source", {}).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await Promise.race([
            restoreEntered.promise,
            yielding.then(() => {
              throw new Error("Yield bypassed the held canonical restore");
            }),
          ]);
          // Join accepted session reads before replacing only the closed fixture file.
          const facts = await Promise.all(
            preparations.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value] : [],
            ),
          );
          const releases = facts.map((read) => vi.spyOn(read, "release"));
          if (mode === "replaced") {
            await fs.rename(replacement, physicalPath);
            expect(await fs.readFile(physicalPath)).toEqual(originalBytes);
          }
          releaseRestore.resolve();
          const outcome = await yielding;
          if (mode === "replaced") {
            expect(outcome).toMatchObject({ error: { outcome: "not-committed" } });
            expect(onYield).not.toHaveBeenCalled();
            expect(subagentRuns.get(runId)?.requesterTurnYielded).toBeUndefined();
          } else if (mode === "empty") {
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
    let writes = 0;
    let closing: Promise<void> | undefined;
    const runWorker = runSubagentStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        runWorker(
          context,
          (scope) =>
            operation({
              ...scope,
              execute: async (...args) => {
                const result = await scope.execute(...args);
                if (args[0].type === "subagents.persistChanges" && ++writes === 1) {
                  if (outcome === "transport failure after commit") {
                    throw new SqliteWorkerError(
                      "cohort release acknowledgement lost",
                      "outcome-unknown",
                    );
                  }
                  closing = closeOpenClawStateDatabaseAsync();
                }
                return result;
              },
            }),
          options,
        ),
      );
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
      expect(writes).toBe(1);
      expect(fixture.wake).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(writes).toBe(1);
      expect(fixture.wake).not.toHaveBeenCalled();
      await closing;
      await closeOpenClawStateDatabaseAsync();
      await nativePersistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
      const restored = expectDefined(subagentRuns.get(entry.runId), "released durable cohort");
      expect(restored).not.toBe(entry);
      expect(restored.requesterTurnRunId).toBeUndefined();
      expect(restored.requesterTurnYielded).toBeUndefined();
      expect(restored.requesterSettleWake?.rearmGeneration).toBe(1);
      expect(writes).toBe(1);
    } finally {
      await closing;
      worker.mockRestore();
    }
  },
);

it("recovers an untransferred requester cohort after restart in one write", async () => {
  vi.useFakeTimers();
  const { entries } = await createYieldedChild(true);
  let writes = 0;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      runSubagentStateWorkerOperation(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: (...args) => {
              if (args[0].type === "subagents.persistChanges") {
                writes += 1;
              }
              return scope.execute(...args);
            },
          }),
        options,
      ),
    );
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
    expect(subagentRuns.get(restored.runId)?.requesterTurnRunId).toBeUndefined();
    expect(subagentRuns.get(restored.runId)?.requesterTurnYielded).toBeUndefined();
    expect(subagentRuns.get(restored.runId)?.requesterSettleWake).toMatchObject({
      batchRunIds: entries.map((entry) => entry.runId).toSorted(),
      rearmGeneration: 1,
    });
    expect(writes).toBe(1);
    expect(fixture.wake).not.toHaveBeenCalled();
  } finally {
    await resetSubagentRegistryForTests({ persist: false });
    worker.mockRestore();
  }
});

it.each([false, true])(
  "does not acknowledge the opposite settlement while a cohort write is pending (yielded: %s)",
  async (requesterYielded) => {
    const { entry, settle } = await createYieldedChild();
    const acknowledged = createDeferred();
    const releaseAcknowledgement = createDeferred();
    let writes = 0;
    const runWorker = runSubagentStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        runWorker(
          context,
          (scope) =>
            operation({
              ...scope,
              execute: async (...args) => {
                const result = await scope.execute(...args);
                if (args[0].type === "subagents.persistChanges" && ++writes === 1) {
                  acknowledged.resolve();
                  await releaseAcknowledgement.promise;
                }
                return result;
              },
            }),
          options,
        ),
      );
    const first = settle(requesterYielded);
    void first.catch(() => {});
    let opposite: Promise<boolean> | undefined;
    try {
      await Promise.race([
        acknowledged.promise,
        first.then(() => {
          throw new Error("Cohort skipped its held acknowledgement");
        }),
      ]);
      opposite = settle(!requesterYielded);
      void opposite.catch(() => {});
      await vi.dynamicImportSettled();
      releaseAcknowledgement.resolve();
      await expect(first).resolves.toBe(true);
      await expect(opposite).rejects.toThrow("Another requester transfer is already pending");
      expect(writes).toBe(1);
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
      worker.mockRestore();
    }
  },
);

it("rejects an overlapping claim without releasing the first authority preparation", async () => {
  const requesterTurnRunId = "joined-authority-parent";
  const runId = "joined-authority-child";
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: requesterSessionKey,
    defaultSessionId: `${requesterSessionKey}-session`,
    lifecycleRevision: "original",
  });
  await registerSubagentRun({
    runId,
    childSessionKey: "agent:main:subagent:joined-authority-child",
    requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId,
    requesterDisplayKey: requesterSessionKey,
    task: "Join the original authority handoff",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
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
  const acknowledged = createDeferred();
  const releaseAcknowledgement = createDeferred();
  let writes = 0;
  const runWorker = runSubagentStateWorkerOperation;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      runWorker(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: async (...args) => {
              const result = await scope.execute(...args);
              if (args[0].type === "subagents.persistChanges" && ++writes === 1) {
                acknowledged.resolve();
                await releaseAcknowledgement.promise;
              }
              return result;
            },
          }),
        options,
      ),
    );
  try {
    await withRequesterTestAuthority(requesterTurnRunId, requesterSessionKey, async () => {
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
      const first = tool.execute("first-authority-yield", {});
      void first.catch(() => {});
      let second: ReturnType<typeof tool.execute> | undefined;
      let secondSettled = false;
      try {
        await Promise.race([
          acknowledged.promise,
          first.then(() => {
            throw new Error("Initial intent skipped its held acknowledgement");
          }),
        ]);
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
        expect(writes).toBe(1);
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
    worker.mockRestore();
  }
});
