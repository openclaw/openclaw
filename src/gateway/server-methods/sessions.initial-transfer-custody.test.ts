import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createRequesterYieldCallback } from "../../agents/openclaw-tools.requester-yield.js";
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { createLifecycleControllerFixture } from "../../agents/subagents/registry/subagent-registry-lifecycle-controller.test-support.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { commitRequesterInitialTransfer } from "../../agents/subagents/registry/subagent-registry-requester-wake-commit.js";
import * as registryState from "../../agents/subagents/registry/subagent-registry-state.js";
import { observeRootWork } from "../../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { revokeRequesterCronAuthority } from "../../agents/subagents/requester-cron-authority.js";
import * as requesterAttachment from "../../agents/subagents/requester-final-attachment.js";
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolvePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
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
  const nativeState = await vi.importActual<typeof registryState>(
    "../../agents/subagents/registry/subagent-registry-state.js",
  );
  vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
    nativeState.persistSubagentRunsToDiskAsyncOrThrow,
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
    nativeState,
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

it.each(["preselected", "selected by mutation", "already published"] as const)(
  "retires a completed initial transfer only after publication (%s)",
  async (mode) => {
    const { entry, nativeState } = await createYieldedChild();
    entry.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
    entry.completion = {
      required: true,
      resultText: "Completed child result",
      capturedAt: Date.now(),
    };
    entry.delivery = { status: "delivered" };
    entry.requesterSettleWake = undefined;
    const stateContext = captureOpenClawStateWorkerContext();
    await nativeState.persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, [entry.runId], {
      context: stateContext,
    });
    if (mode === "already published") {
      subagentRuns.delete(entry.runId);
      await nativeState.persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, [entry.runId], {
        context: stateContext,
      });
    }
    const context = createLifecycleControllerFixture(
      {
        entry,
        runs: subagentRuns,
        persistAsyncOrThrow: (writeContext, callbacks, ...ids) =>
          nativeState.persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, ids, {
            context: writeContext,
            ...callbacks,
          }),
      },
      {
        callGateway: fixture.gateway,
        cleanupBrowserSessionsForLifecycleEnd: fixture.cleanup,
        ownersByEntry: new WeakMap(),
      },
    );
    const persist = vi.spyOn(context.options, "persistAsyncOrThrow");
    const retire = new Set(mode === "selected by mutation" ? [] : [entry]);
    const mutate = vi.fn(() => {
      retire.add(entry);
    });
    const finish = vi.fn(() => {
      expect(subagentRuns.has(entry.runId)).toBe(false);
    });
    await commitRequesterInitialTransfer(context, {
      kind: "completed-cohort",
      entries: [entry],
      stateContext,
      retire,
      alreadyPublished: mode === "already published",
      assertCurrent: () => {},
      assertHandoffCurrent: () => {},
      mutate,
      finish,
      scheduleRetry: () => {},
    });
    expect(mutate).toHaveBeenCalledTimes(mode === "already published" ? 0 : 1);
    expect(persist).toHaveBeenCalledTimes(mode === "already published" ? 0 : 1);
    expect(finish).toHaveBeenCalledOnce();
    expect(subagentRuns.has(entry.runId)).toBe(false);
  },
);

it.each([false, true])(
  "retires the actual completed requester cohort (yielded: %s)",
  async (yielded) => {
    const { entry, settle, nativeState } = await createYieldedChild();
    entry.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
    entry.cleanup = "delete";
    entry.cleanupCompletedAt = Date.now();
    entry.retireAfterRequesterTurn = true;
    entry.delivery = {
      status: "delivered",
      ...(yielded
        ? {
            requesterVisibleFinal: {
              requesterTurnRunId: "staged-cohort-parent",
              batchRunIds: [entry.runId],
            },
          }
        : {}),
    };
    await nativeState.persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, [entry.runId], {
      context: captureOpenClawStateWorkerContext(),
    });
    expect(await settle(yielded)).toBe(true);
    expect(subagentRuns.has(entry.runId)).toBe(false);
    expect(fixture.wake).not.toHaveBeenCalled();
  },
);

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
    resetSubagentRegistryForTests({ persist: false });
    await closeOpenClawStateDatabaseAsync();
    const nativeState = await vi.importActual<typeof registryState>(
      "../../agents/subagents/registry/subagent-registry-state.js",
    );
    vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      nativeState.persistSubagentRunsToDiskAsyncOrThrow,
    );
    const restoreEntered = createDeferred();
    const releaseRestore = createDeferred();
    vi.mocked(registryState.restoreSubagentRunsFromDisk).mockImplementation(async (...args) => {
      const result = await nativeState.restoreSubagentRunsFromDisk(...args);
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
    }
    expect(hostSql.counts).toEqual(emptySqliteCounts());
  },
);

it("finishes the initial handoff after the same child completes during promotion retry", async () => {
  vi.useFakeTimers();
  const { entry, settle, onYield } = await createYieldedChild();
  const originalExecution = entry.execution;
  const promotionFailed = createDeferred();
  const promotion = vi
    .spyOn(requesterAttachment, "promoteRequesterFinalAttachment")
    .mockImplementationOnce(() => {
      promotionFailed.resolve();
      throw new Error("initial cohort promotion interrupted");
    });
  const settlement = settle();
  try {
    await Promise.race([
      promotionFailed.promise,
      settlement.then(() => {
        throw new Error("Cohort handoff skipped promotion");
      }),
    ]);
    expect(entry.requesterTurnRunId).toBe("staged-cohort-parent");
    expect(entry.requesterSettleWake?.rearmGeneration).toBe(1);
    const settleRootWork = observeRootWork();
    fixture.announce.mockResolvedValue("requester_turn_pending");
    emitAgentEvent({
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "Child finished during the handoff." },
      },
    });
    await settleRootWork();
    expect(entry.execution).not.toBe(originalExecution);
    expect(entry.execution.status).toBe("terminal");
    expect(fixture.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(settlement).resolves.toBe(true);
    expect(subagentRuns.get(entry.runId)).toBe(entry);
    expect(entry.requesterTurnRunId).toBeUndefined();
    expect(entry.requesterTurnYielded).toBeUndefined();
    expect(entry.requesterSettleWake?.rearmGeneration).toBe(1);
    expect(entry.execution.status).toBe("terminal");
    expect(onYield).toHaveBeenCalledOnce();
  } finally {
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.allSettled([settlement]);
    promotion.mockRestore();
  }
});

it.each(["superseded", "unknown"] as const)(
  "never repeats the acknowledged cohort release after its %s result",
  async (outcome) => {
    vi.useFakeTimers();
    const { entry, settle, nativeState } = await createYieldedChild();
    let writes = 0;
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
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
                if (args[0].type === "subagents.persistChanges" && ++writes === 2) {
                  if (outcome === "unknown") {
                    throw new SqliteWorkerError(
                      "cohort release acknowledgement lost",
                      "outcome-unknown",
                    );
                  }
                  entry.execution = { ...entry.execution };
                }
                return result;
              },
            }),
          options,
        ),
      );
    try {
      await expect(settle()).rejects.toMatchObject(
        outcome === "unknown"
          ? { outcome: "unknown" }
          : { outcome: "committed", publication: "superseded" },
      );
      expect(writes).toBe(2);
      expect(entry.requesterTurnRunId).toBe("staged-cohort-parent");
      expect(fixture.wake).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(writes).toBe(2);
      expect(fixture.wake).not.toHaveBeenCalled();
      await closeOpenClawStateDatabaseAsync();
      await nativeState.restoreSubagentRunsFromDisk({ runs: subagentRuns });
      const restored = expectDefined(subagentRuns.get(entry.runId), "released durable cohort");
      expect(restored).not.toBe(entry);
      expect(restored.requesterTurnRunId).toBeUndefined();
      expect(restored.requesterTurnYielded).toBeUndefined();
      expect(restored.requesterSettleWake?.rearmGeneration).toBe(1);
      expect(writes).toBe(2);
    } finally {
      worker.mockRestore();
    }
  },
);

it.each([
  { prepared: false, missing: false },
  { prepared: true, missing: false },
  { prepared: true, missing: true },
])(
  "recovers the original requester transfer after restart (prepared: $prepared, missing member: $missing)",
  async ({ prepared, missing }) => {
    vi.useFakeTimers();
    const { entries, settle, nativeState } = await createYieldedChild(true);
    const failed = createDeferred();
    const promotion = vi
      .spyOn(requesterAttachment, "promoteRequesterFinalAttachment")
      .mockImplementationOnce(() => {
        failed.resolve();
        throw new Error("initial promotion interrupted before restart");
      });
    let writes = 0;
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        runWorker(
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
    const settlement = prepared ? settle() : undefined;
    void settlement?.catch(() => {});
    try {
      if (settlement) {
        await Promise.race([
          failed.promise,
          settlement.then(() => {
            throw new Error("Cohort skipped the held promotion");
          }),
        ]);
      } else {
        promotion.mockRestore();
      }
      expect(writes).toBe(prepared ? 1 : 0);
      resetSubagentRegistryForTests({ persist: false });
      if (settlement) {
        await expect(settlement).rejects.toMatchObject({ outcome: "committed" });
      }
      await closeOpenClawStateDatabaseAsync();
      if (missing) {
        // A durable partial cohort must never become a new, smaller first-stage write.
        await nativeState.persistSubagentRunsToDiskAsyncOrThrow(subagentRuns, [entries[1]!.runId], {
          context: captureOpenClawStateWorkerContext(),
        });
      }
      const beforeRestore = writes;
      await initSubagentRegistry();
      const restored = expectDefined(
        subagentRuns.get(entries[0]!.runId),
        "restored prepared cohort",
      );
      expect(restored).not.toBe(entries[0]);
      expect(restored.requesterTurnRunId).toBe("staged-cohort-parent");
      if (prepared) {
        expect(restored.requesterSettleWake).toMatchObject({
          batchRunIds: entries.map((entry) => entry.runId).toSorted(),
          rearmGeneration: 1,
        });
      } else {
        expect(restored.requesterSettleWake).toBeUndefined();
      }
      const context = sessionSharingTestContext(vi.fn(), getRuntimeConfig());
      context.resolveGatewayContext = () => context;
      const activation = activateSubagentRegistry(context.resolveGatewayContext);
      if (missing) {
        await expect(activation).rejects.toMatchObject({
          outcome: "committed",
          publication: "superseded",
        });
        expect(restored.requesterTurnRunId).toBe("staged-cohort-parent");
        expect(writes).toBe(beforeRestore);
      } else {
        await activation;
        expect(restored.requesterTurnRunId).toBeUndefined();
        expect(restored.requesterTurnYielded).toBeUndefined();
        expect(restored.requesterSettleWake?.rearmGeneration).toBe(1);
        expect(writes).toBe(beforeRestore + (prepared ? 1 : 2));
      }
      expect(fixture.wake).not.toHaveBeenCalled();
    } finally {
      resetSubagentRegistryForTests({ persist: false });
      await Promise.allSettled(settlement ? [settlement] : []);
      promotion.mockRestore();
      worker.mockRestore();
    }
  },
);

it.each([false, true])(
  "does not acknowledge the opposite settlement while a cohort write is pending (yielded: %s)",
  async (requesterYielded) => {
    const { entry, settle } = await createYieldedChild();
    const acknowledged = createDeferred();
    const releaseAcknowledgement = createDeferred();
    let writes = 0;
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
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
      await expect(opposite).rejects.toMatchObject({ outcome: "not-committed" });
      expect(writes).toBe(requesterYielded ? 2 : 1);
      const { loadSubagentRegistryFromSqlite } = await vi.importActual<
        typeof import("../../agents/subagents/registry/subagent-registry.store.sqlite.js")
      >("../../agents/subagents/registry/subagent-registry.store.sqlite.js");
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

it("retains the committed cohort when release admission fails and the caller retires", async () => {
  const { entry, settle } = await createYieldedChild();
  const refused = createDeferred();
  let attempts = 0;
  let writes = 0;
  const runWorker = stateWorker.runOpenClawStateWorkerOperation;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      runWorker(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: async (...args) => {
              if (args[0].type === "subagents.persistChanges" && ++attempts === 2) {
                refused.resolve();
                throw new Error("release refused before SQL admission");
              }
              const result = await scope.execute(...args);
              if (args[0].type === "subagents.persistChanges") {
                writes += 1;
              }
              return result;
            },
          }),
        options,
      ),
    );
  const settlement = settle();
  void settlement.catch(() => {});
  try {
    await Promise.race([
      refused.promise,
      settlement.then(() => {
        throw new Error("Cohort skipped its marker-release write");
      }),
    ]);
    resetSubagentRegistryForTests({ persist: false });
    await expect(settlement).rejects.toMatchObject({
      outcome: "committed",
      publication: "published",
    });
    expect(attempts).toBe(2);
    expect(writes).toBe(1);
    const { loadSubagentRegistryFromSqlite } = await vi.importActual<
      typeof import("../../agents/subagents/registry/subagent-registry.store.sqlite.js")
    >("../../agents/subagents/registry/subagent-registry.store.sqlite.js");
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)).toMatchObject({
      requesterTurnRunId: "staged-cohort-parent",
      requesterTurnYielded: true,
      requesterSettleWake: { rearmGeneration: 1 },
    });
  } finally {
    resetSubagentRegistryForTests({ persist: false });
    await Promise.allSettled([settlement]);
    worker.mockRestore();
  }
});

it("joins a real authority preparation without releasing borrowed facts before yield", async () => {
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
  const nativeState = await vi.importActual<typeof registryState>(
    "../../agents/subagents/registry/subagent-registry-state.js",
  );
  vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
    nativeState.persistSubagentRunsToDiskAsyncOrThrow,
  );
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
  const runWorker = stateWorker.runOpenClawStateWorkerOperation;
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
        await expect(second).resolves.toMatchObject({ details: { status: "yielded" } });
        expect(writes).toBe(1);
        expect(reads).toBe(2);
        expect(onYield).toHaveBeenCalledTimes(2);
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
