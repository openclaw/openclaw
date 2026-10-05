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
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { observeRootWork } from "../../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { loadSubagentSessionEntry } from "../../agents/subagents/registry/subagent-session-reconciliation.js";
import { revokeRequesterCronAuthority } from "../../agents/subagents/requester-cron-authority.js";
import * as requesterAttachment from "../../agents/subagents/requester-final-attachment.js";
import { createSessionsYieldTool } from "../../agents/tools/sessions-yield-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolvePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  AgentDatabaseAdmissionError,
  assertAgentDatabaseAdmitted,
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
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

it("finishes the initial handoff after the same child completes during promotion retry", async () => {
  vi.useFakeTimers();
  const { entry, settle, onYield } = await createYieldedChild();
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
    expect(subagentRuns.get(entry.runId)?.requesterTurnRunId).toBe("staged-cohort-parent");
    expect(subagentRuns.get(entry.runId)?.requesterSettleWake?.rearmGeneration).toBe(1);
    const terminalPublished = createDeferred();
    const stopObserving = subscribeSubagentRunChanges("persistence", () => {
      if (subagentRuns.get(entry.runId)?.execution.status === "terminal") {
        terminalPublished.resolve();
      }
    });
    const settleRootWork = observeRootWork();
    fixture.announce.mockResolvedValue("requester_turn_pending");
    try {
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
      await terminalPublished.promise;
      await settleRootWork();
    } finally {
      stopObserving();
    }
    expect(subagentRuns.get(entry.runId)?.execution.status).toBe("terminal");
    expect(fixture.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(settlement).resolves.toBe(true);
    expect(subagentRuns.get(entry.runId)).not.toBe(entry);
    expect(subagentRuns.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
    expect(subagentRuns.get(entry.runId)?.requesterTurnYielded).toBeUndefined();
    expect(subagentRuns.get(entry.runId)?.requesterSettleWake?.rearmGeneration).toBe(1);
    expect(subagentRuns.get(entry.runId)?.execution.status).toBe("terminal");
    expect(onYield).toHaveBeenCalledOnce();
  } finally {
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.allSettled([settlement]);
    promotion.mockRestore();
  }
});

it.each(["source retirement", "transport failure after commit"] as const)(
  "never repeats the acknowledged cohort release after its %s result",
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
                if (args[0].type === "subagents.persistChanges" && ++writes === 2) {
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
      expect(writes).toBe(2);
      expect(fixture.wake).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(writes).toBe(2);
      expect(fixture.wake).not.toHaveBeenCalled();
      await closing;
      await closeOpenClawStateDatabaseAsync();
      await nativePersistence.restoreSubagentRunsFromDisk({ runs: subagentRuns });
      const restored = expectDefined(subagentRuns.get(entry.runId), "released durable cohort");
      expect(restored).not.toBe(entry);
      expect(restored.requesterTurnRunId).toBeUndefined();
      expect(restored.requesterTurnYielded).toBeUndefined();
      expect(restored.requesterSettleWake?.rearmGeneration).toBe(1);
      expect(writes).toBe(2);
    } finally {
      await closing;
      worker.mockRestore();
    }
  },
);

it.each([
  { prepared: false, memberState: "present" },
  { prepared: true, memberState: "present" },
  { prepared: true, memberState: "retired" },
  { prepared: true, memberState: "rearmed" },
])(
  "recovers the original requester transfer after restart (prepared: $prepared, member: $memberState)",
  async ({ prepared, memberState }) => {
    const conflicted = memberState === "rearmed";
    vi.useFakeTimers();
    const { entries, settle } = await createYieldedChild(true);
    const healthyRunId = "zz-independent-restored-child";
    if (conflicted) {
      const healthyRequester = "agent:other:independent-restored-requester";
      const healthyChild = "agent:other:subagent:independent-restored-child";
      for (const sessionKey of [healthyRequester, healthyChild]) {
        await writeSubagentSessionEntry({
          stateDir: fixture.stateDir,
          agentId: "other",
          sessionKey,
          defaultSessionId: `${sessionKey}-session`,
        });
      }
      await registerSubagentRun({
        runId: healthyRunId,
        childSessionKey: healthyChild,
        requesterSessionKey: healthyRequester,
        requesterAgentId: "other",
        requesterTurnRunId: "independent-restored-parent",
        requesterDisplayKey: requesterSessionKey,
        task: "Keep independent restoration moving",
        cleanup: "keep",
        expectsCompletionMessage: true,
      });
    }
    const failed = createDeferred();
    const promotion = vi
      .spyOn(requesterAttachment, "promoteRequesterFinalAttachment")
      .mockImplementationOnce(() => {
        failed.resolve();
        throw new Error("initial promotion interrupted before restart");
      });
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
      if (memberState !== "present") {
        const sibling = expectDefined(entries[1], "prepared cohort sibling");
        await registryPersistence.mutateSubagentRuns(
          [sibling.runId],
          (rows) => {
            const next =
              memberState === "retired"
                ? null
                : structuredClone(expectDefined(rows.get(sibling.runId), "rearmed sibling"));
            if (next) {
              const wake = expectDefined(next.requesterSettleWake, "prepared sibling wake");
              wake.rearmGeneration =
                expectDefined(wake.rearmGeneration, "prepared wake generation") + 1;
            }
            return { value: undefined, postimages: new Map([[sibling.runId, next]]) };
          },
          { context: captureOpenClawStateWorkerContext() },
        );
      }
      await resetSubagentRegistryForTests({ persist: false });
      if (settlement) {
        await expect(settlement).rejects.toMatchObject({ outcome: "committed" });
      }
      await closeOpenClawStateDatabaseAsync();
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
      if (conflicted) {
        recordAgentDatabaseAdmissions(
          [
            createAgentDatabaseInspectionRefusal({
              agentId: "main",
              paths: [fixture.stateDir],
              pending: true,
              reason: "Startup preparation is pending",
            }),
          ],
          { source: "startup" },
        );
        expect(() => assertAgentDatabaseAdmitted("main")).toThrow(AgentDatabaseAdmissionError);
        // Generic restoration deliberately reads existing sessions through the
        // read-only owner, without borrowing pending writable admission.
        expect(
          loadSubagentSessionEntry({ childSessionKey: restored.childSessionKey }),
        ).toMatchObject({
          sessionId: `${restored.childSessionKey}-session`,
        });
      }
      const activation = activateSubagentRegistry(context.resolveGatewayContext);
      if (conflicted) {
        await expect(activation).rejects.toMatchObject({
          outcome: "committed",
          publication: "superseded",
        });
        expect(subagentRuns.get(restored.runId)?.requesterTurnRunId).toBe("staged-cohort-parent");
        expect(subagentRuns.get(restored.runId)?.requesterSettleWake?.batchRunIds).toEqual(
          entries.map((entry) => entry.runId).toSorted(),
        );
        expect(subagentRuns.get(healthyRunId)?.requesterTurnRunId).toBeUndefined();
        expect(writes).toBe(beforeRestore + 1);
      } else {
        await activation;
        expect(subagentRuns.get(restored.runId)?.requesterTurnRunId).toBeUndefined();
        expect(subagentRuns.get(restored.runId)?.requesterTurnYielded).toBeUndefined();
        expect(subagentRuns.get(restored.runId)?.requesterSettleWake).toMatchObject({
          batchRunIds: entries.map((entry) => entry.runId).toSorted(),
          rearmGeneration: 1,
        });
        // A retired member leaves the original batch identity and release-only write intact.
        expect(writes).toBe(beforeRestore + (prepared ? 1 : 2));
        if (memberState === "retired") {
          expect(subagentRuns.has(entries[1]!.runId)).toBe(false);
        }
      }
      expect(fixture.wake).not.toHaveBeenCalled();
    } finally {
      if (conflicted) {
        recordAgentDatabaseAdmissions([], { source: "startup" });
      }
      await resetSubagentRegistryForTests({ persist: false });
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
    await resetSubagentRegistryForTests({ persist: false });
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
    await resetSubagentRegistryForTests({ persist: false });
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
