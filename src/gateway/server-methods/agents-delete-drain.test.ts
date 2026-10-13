import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import {
  captureEmbeddedRunDrainTarget,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionInventory from "../../config/sessions/session-entry-read-runtime.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { invalidateAgentDeletionJournalStatus } from "../../state/agent-deletion-journal-status.js";
import * as deletionJournals from "../../state/agent-deletion-journal.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  removeChatAbortControllerEntry,
  runWithChatAbortExecution,
} from "../chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "../terminal/session-manager.test-helpers.js";
import {
  createWorkerInferenceSessionControls,
  registerWorkerInferenceSessionControl,
} from "../worker-environments/inference-control-internal.js";
import { createWorkerInferenceServiceStub } from "../worker-environments/inference-control.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";
import { deleteGatewayAgent } from "./agents-delete.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";

afterEach(() => vi.restoreAllMocks());

function hasOnlyAuthorityFailures(error: unknown, message: string): boolean {
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every((failure: unknown) => hasOnlyAuthorityFailures(failure, message))
    );
  }
  return error instanceof Error && error.message.includes(message);
}

it.each(["rollback", "rollback during recovery"] as const)(
  "keeps session writes fenced after a draining deletion fails until %s",
  async (rollbackPath) => {
    await withOpenClawTestState({ label: "deletion-pending-write" }, async (state) => {
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: {
            keeper: { workspace: state.workspaceDir },
            doomed: { workspace: state.path("doomed") },
          },
        },
      });
      await captureRuntimeConfigAsyncReader()();
      const scope = { agentId: "doomed", env: state.env, sessionKey: "agent:doomed:pending" };
      await expect(
        replaceSessionEntry(scope, { sessionId: "pending", updatedAt: 1 }),
      ).resolves.toMatchObject({ sessionId: "pending" });
      const inventory = vi
        .spyOn(sessionInventory, "readSessionEntrySummariesInWorker")
        .mockRejectedValueOnce(new Error("inventory failed"));
      await expect(
        deleteGatewayAgent("doomed", false, createDirectChatContext({ getRuntimeConfig })),
      ).rejects.toThrow("inventory failed");
      inventory.mockRestore();
      expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "draining",
        cleanupCompleted: false,
      });
      const update = vi.fn(() => ({ label: "must not be written" }));
      await expect(patchSessionEntryCore(scope, update, { skipMaintenance: true })).rejects.toThrow(
        "deletion cleanup is still pending",
      );
      expect(update).not.toHaveBeenCalled();
      const rollback = () =>
        withAgentDeletion("doomed", async (begin) => {
          const deletion = await begin({
            agentId: "doomed",
            agentDir: state.agentDir("doomed"),
            workspaceDir: state.path("doomed"),
            sessionsDir: state.sessionsDir("doomed"),
            phase: "draining",
          });
          await deletion.rollback();
        });
      if (rollbackPath === "rollback during recovery") {
        const listPending = deletionJournals.listPendingAgentDeletionJournalsAsync;
        vi.spyOn(deletionJournals, "listPendingAgentDeletionJournalsAsync").mockImplementationOnce(
          async () => {
            const pending = await listPending();
            await rollback();
            return pending;
          },
        );
        await resumeAgentDeletions(createDirectChatContext({ getRuntimeConfig }));
      } else {
        await rollback();
      }
      expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toBeUndefined();
      await expect(
        patchSessionEntryCore(scope, () => ({ label: "resumed" }), { skipMaintenance: true }),
      ).resolves.toMatchObject({ label: "resumed" });
    });
  },
);

it("preserves another agent's replacement run and admissions in a shared store during inventory", async () => {
  await withOpenClawTestState({ label: "deletion-run-identity" }, async (state) => {
    const storePath = state.path("shared-sessions.sqlite");
    const cfg = {
      agents: { entries: { keeper: {}, doomed: {} } },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionId = "reused-session";
    const original = createEmbeddedRunHandle({ runId: "original" });
    const replacementAbort = vi.fn(() => clearActiveEmbeddedRun(sessionId, replacement));
    const replacement = createEmbeddedRunHandle({ runId: "replacement", abort: replacementAbort });
    const entered = createDeferred();
    const inventory =
      createDeferred<
        Awaited<ReturnType<typeof sessionInventory.readSessionEntrySummariesInWorker>>
      >();
    vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockImplementation(() => {
      entered.resolve();
      return inventory.promise;
    });
    setActiveEmbeddedRun(sessionId, original, "agent:doomed:active", undefined, "doomed");
    const draining = drainAgentDeletionRuns("doomed", cfg, createDirectChatContext(), () => {});
    let active: SessionWorkAdmissionLease | undefined;
    let pending: Promise<SessionWorkAdmissionLease> | undefined;
    const activeInterrupted = vi.fn(() => active?.release());
    const pendingInterrupted = vi.fn();
    try {
      await awaitGateBeforeSettlement(entered.promise, draining, "drain skipped session inventory");
      clearActiveEmbeddedRun(sessionId, original);
      setActiveEmbeddedRun(sessionId, replacement, "agent:keeper:active", undefined, "keeper");
      const admission = {
        agentId: "keeper",
        scope: storePath,
        identities: ["agent:keeper:active", sessionId],
        owner: Symbol("keeper-turn"),
        serializeOwner: true,
        assertAllowed: () => {},
      };
      active = await beginSessionWorkAdmission({ ...admission, onInterrupt: activeInterrupted });
      pending = beginSessionWorkAdmission({ ...admission, onInterrupt: pendingInterrupted });
      void pending.catch(() => {});
      inventory.resolve([]);
      await expect(draining).resolves.toBeUndefined();
      expect(replacementAbort).not.toHaveBeenCalled();
      expect(activeInterrupted).not.toHaveBeenCalled();
      expect(pendingInterrupted).not.toHaveBeenCalled();
      expect(active.isActive()).toBe(true);
      active.release();
      const successor = await pending;
      expect(successor.isActive()).toBe(true);
      successor.release();
    } finally {
      inventory.resolve([]);
      clearActiveEmbeddedRun(sessionId, original);
      clearActiveEmbeddedRun(sessionId, replacement);
      active?.release();
      await pending?.then(
        (successor) => successor.release(),
        () => {},
      );
      await Promise.allSettled([draining]);
    }
  });
});

it.each([false, true])(
  "coalesces physical session aliases while draining every terminal (placement: %s)",
  async (placed) => {
    await withOpenClawTestState({ label: "deletion-session-aliases" }, async (state) => {
      const cfg = { agents: { entries: { doomed: {}, keeper: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionId = "cron-shared-session";
      const baseKey = "agent:doomed:cron:job";
      const runKey = `${baseKey}:run:run-id`;
      const keys = placed ? [runKey, baseKey] : [baseKey, runKey];
      vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockResolvedValue(
        keys.map((sessionKey) => ({ sessionKey, entry: { sessionId, updatedAt: 1 } })),
      );
      const controls = createWorkerInferenceSessionControls({
        active: new Map(),
        operations: new Map(),
        unknownSettlements: new Map(),
        recovered: Promise.resolve(),
        settleAbort: async () => {},
      });
      const workerEnvironmentService = createWorkerInferenceServiceStub();
      registerWorkerInferenceSessionControl(workerEnvironmentService, controls);
      const placement: WorkerSessionPlacementRecord = {
        agentId: "doomed",
        sessionId,
        sessionKey: baseKey,
        state: "local",
        executionMode: "worker-turn",
        generation: 1,
        turnClaim: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: null,
        activeOwnerEpoch: null,
        workspaceBaseManifestRef: null,
        remoteWorkspaceDir: null,
        workerBundleHash: null,
        lastTranscriptAckCursor: null,
        lastLiveEventAckCursor: null,
        terminalReason: null,
        terminalAtMs: null,
        recoveryError: null,
      };
      const admission = await beginSessionWorkAdmission({
        agentId: "doomed",
        scope: state.path("agents/doomed/sessions/sessions.json"),
        identities: [baseKey, sessionId],
        assertAllowed: () => {},
        onInterrupt: () => admission.release(),
      });
      const terminals = new TerminalSessionManager({ emit: () => {} });
      const ptys = keys.map(() => {
        const pty = makeFakePty();
        const kill = pty.kill.bind(pty);
        pty.kill = () => {
          kill();
          pty.emitExit(0);
        };
        return pty;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        for (const [index, key] of keys.entries()) {
          expectTerminalOpen(
            await terminals.open(
              baseOpenRequest({
                agentId: "doomed",
                owner: agentTerminalOwner(key, sessionId, "doomed"),
                createBackend: async () => ptys[index]!,
              }),
            ),
          );
        }
        const context = createDirectChatContext({
          workerEnvironmentService,
          terminalSessions: terminals,
          ...(placed
            ? {
                workerSessionPlacementService: {
                  getMany: () => new Map([[sessionId, placement]]),
                },
              }
            : {}),
        });
        await expect(
          drainAgentDeletionRuns("doomed", cfg, context, () => {}),
        ).resolves.toBeUndefined();
        expect(admission.isActive()).toBe(false);
        expect(ptys.map((pty) => pty.killed)).toEqual([true, true]);
        expect(terminals.size).toBe(0);
        const released = controls.reserveSessionDrain(sessionId).accept();
        released.start();
        await released.drained;
        released.release();
      } finally {
        terminals.disposeAll();
        vi.useRealTimers();
        admission.release();
        await controls.stop();
      }
    });
  },
);

const authorityLossCases = [
  ...(["unkeyed", "protected"] as const).flatMap((owner) =>
    (["replaced", "completed", "revoked"] as const).map((transition) => ({ owner, transition })),
  ),
  { owner: "protected-embedded", transition: "replaced" } as const,
  { owner: "protected-embedded-replacement", transition: "replaced" } as const,
];

it.each(authorityLossCases)(
  "joins accepted $owner cancellation but rejects the next after deletion authority is $transition",
  async ({ owner, transition }) => {
    await withOpenClawTestState({ label: `deletion-${owner}-${transition}` }, async (state) => {
      const cfg = { agents: { entries: { doomed: {}, keeper: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const prefix = `${owner}-${transition}`;
      const firstId = `${prefix}-first`;
      const laterId = `${prefix}-later`;
      const authorityMessage =
        transition === "revoked"
          ? "agent deletion core:agent-deletion/doomed was lost"
          : "Agent doomed deletion no longer owns database cleanup.";
      const sessionKey = "agent:doomed:protected";
      if (owner !== "unkeyed") {
        await replaceSessionEntry(
          { agentId: "doomed", env: state.env, sessionKey },
          { sessionId: "protected-session", updatedAt: 1 },
        );
      }
      const completion = createDeferred();
      const authorityRejected = createDeferred<unknown>();
      const traces: unknown[] = [];
      const log = vi.spyOn(diagnosticLogger, "debug");
      const unsubscribe = onAgentRuntimeEvent((event) => {
        if (event.runId === firstId || event.runId === laterId) {
          traces.push({ runId: event.runId, stream: event.stream, data: event.data });
        }
      });
      let cleanup = async () => {};
      let proofCompleted = false;
      try {
        const operation = withAgentDeletion("doomed", async (begin) => {
          const deletion = await begin({
            agentId: "doomed",
            agentDir: state.agentDir("doomed"),
            workspaceDir: state.path("doomed"),
            sessionsDir: state.sessionsDir("doomed"),
            phase: "draining",
          });
          // Deliberately mutate live authority as a competing writer. Closing the
          // owner first would miss the effect-boundary check this fixture proves.
          using foreign = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
          let changedRows: number | bigint | undefined;
          const revoke = () => {
            const sql = {
              replaced:
                "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'doomed'",
              completed:
                "UPDATE agent_deletion_journal SET cleanup_completed = 1 WHERE agent_id = 'doomed'",
              revoked:
                "DELETE FROM state_leases WHERE scope = 'core:agent-deletion' AND lease_key = 'doomed'",
            }[transition];
            changedRows = foreign.prepare(sql).run().changes;
            invalidateAgentDeletionJournalStatus(
              openOpenClawStateDatabase({ env: state.env }).db,
              "doomed",
            );
          };
          const authorize = () => {
            try {
              deletion.assertCurrentFinal();
            } catch (error) {
              authorityRejected.resolve(error);
              throw error;
            }
          };
          let startDrain: () => Promise<unknown>;
          let settleFirst: () => void;
          let wasFirstCancelled: () => boolean;
          let wasLaterCancelled: () => boolean;
          let joinEmbedded: ((draining: Promise<unknown>) => Promise<void>) | undefined;
          if (owner === "unkeyed") {
            const firstAbort = vi.fn(revoke);
            const laterAbort = vi.fn();
            const first = createEmbeddedRunHandle({ runId: firstId, abort: firstAbort });
            const later = createEmbeddedRunHandle({ runId: laterId, abort: laterAbort });
            setActiveEmbeddedRun(firstId, first, undefined, undefined, "doomed");
            setActiveEmbeddedRun(laterId, later, undefined, undefined, "doomed");
            vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockResolvedValue([]);
            startDrain = () => drainAgentDeletionRuns("doomed", cfg, context, authorize);
            settleFirst = () => clearActiveEmbeddedRun(firstId, first);
            wasFirstCancelled = () => firstAbort.mock.calls.length > 0;
            wasLaterCancelled = () => laterAbort.mock.calls.length > 0;
            cleanup = async () => {
              clearActiveEmbeddedRun(firstId, first);
              clearActiveEmbeddedRun(laterId, later);
            };
          } else {
            const entry = (): ChatAbortControllerEntry => ({
              agentId: "doomed",
              sessionKey,
              sessionId: "protected-session",
              controller: new AbortController(),
              controlUiVisible: false,
              startedAtMs: 1,
              expiresAtMs: Infinity,
            });
            const first = entry();
            const later = entry();
            const backendAbort = new AbortController();
            const replacement = owner === "protected-embedded-replacement";
            const controllerBackendAbort = replacement ? new AbortController() : backendAbort;
            const embedded =
              owner === "protected"
                ? undefined
                : {
                    ...createEmbeddedRunHandle({
                      runId: firstId,
                      abort: () => backendAbort.abort(),
                    }),
                    isAborted: () => backendAbort.signal.aborted,
                  };
            if (embedded) {
              if (replacement) {
                setActiveEmbeddedRun(
                  first.sessionId,
                  createEmbeddedRunHandle({
                    runId: firstId,
                    abort: () => controllerBackendAbort.abort(),
                  }),
                  sessionKey,
                  undefined,
                  "doomed",
                );
              }
              setActiveEmbeddedRun(first.sessionId, embedded, sessionKey, undefined, "doomed");
            }
            const embeddedTarget = embedded
              ? captureEmbeddedRunDrainTarget(first.sessionId, { agentId: "doomed" })
              : undefined;
            const embeddedJoined = createDeferred();
            if (embeddedTarget) {
              const waitForEnd = embeddedTarget.waitForEnd;
              vi.spyOn(embeddedTarget, "waitForEnd").mockImplementation((timeoutMs) => {
                embeddedJoined.resolve();
                return waitForEnd(timeoutMs);
              });
            }
            context.chatAbortControllers.set(firstId, first);
            context.chatAbortControllers.set(laterId, later);
            first.controller.signal.addEventListener(
              "abort",
              () => {
                if (embedded) {
                  controllerBackendAbort.abort();
                }
                revoke();
              },
              { once: true },
            );
            const execution = runWithChatAbortExecution(
              first,
              () => completion.promise,
              () => removeChatAbortControllerEntry(context.chatAbortControllers, firstId, first),
            );
            startDrain = () =>
              prepareSessionLifecycleDrain({
                action: "delete",
                timeoutMs: null,
                context,
                agentId: "doomed",
                storePath: state.path("sessions.json"),
                sessionKey,
                sessionKeys: [sessionKey],
                sessionId: "protected-session",
                lifecycleIdentities: [sessionKey, "protected-session"],
                embeddedRun: embeddedTarget,
                authorize,
              });
            if (embedded) {
              joinEmbedded = async (draining) => {
                completion.resolve();
                await execution;
                if (replacement) {
                  await expect(
                    awaitGateBeforeSettlement(
                      draining,
                      embeddedJoined.promise,
                      "deletion joined an uncancelled replacement sharing the run id",
                    ),
                  ).rejects.toSatisfy((error: unknown) =>
                    hasOnlyAuthorityFailures(error, authorityMessage),
                  );
                  expect(backendAbort.signal.aborted).toBe(false);
                  expect(embeddedTarget?.isActive()).toBe(true);
                } else {
                  await awaitGateBeforeSettlement(
                    embeddedJoined.promise,
                    draining,
                    "deletion released its aborted embedded owner before settlement",
                  );
                }
              };
            }
            settleFirst = () => {
              completion.resolve();
              if (embedded) {
                clearActiveEmbeddedRun(first.sessionId, embedded);
              }
            };
            wasFirstCancelled = () => first.controller.signal.aborted;
            wasLaterCancelled = () => later.controller.signal.aborted;
            cleanup = async () => {
              completion.resolve();
              await execution;
              if (embedded) {
                clearActiveEmbeddedRun(first.sessionId, embedded);
                embeddedTarget?.release();
              }
              context.chatAbortControllers.clear();
            };
          }
          const draining = startDrain();
          const settled = vi.fn();
          void draining.then(settled, settled);
          try {
            const rejection = await awaitGateBeforeSettlement(
              authorityRejected.promise,
              draining,
              "cancellation did not recheck live deletion authority",
            );
            expect(rejection).toBeInstanceOf(Error);
            expect(String(rejection)).toContain(authorityMessage);
            expect(changedRows).toBe(1);
            expect(wasFirstCancelled()).toBe(true);
            expect(wasLaterCancelled()).toBe(false);
            expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toMatchObject({
              operationId: transition === "replaced" ? "replacement" : deletion.entry.operationId,
              cleanupCompleted: transition === "completed",
            });
            expect(settled).not.toHaveBeenCalled();
            await joinEmbedded?.(draining);
            if (owner !== "protected-embedded-replacement") {
              expect(settled).not.toHaveBeenCalled();
            }
            settleFirst();
            if (owner === "unkeyed") {
              await expect(draining).rejects.toThrow("deletion is still draining");
            } else {
              await expect(draining).rejects.toSatisfy((error: unknown) =>
                hasOnlyAuthorityFailures(error, authorityMessage),
              );
            }
            expect(wasLaterCancelled()).toBe(false);
            if (owner === "unkeyed") {
              traces.push(
                ...log.mock.calls
                  .map(([message]) => message)
                  .filter((message) => message.includes(firstId) || message.includes(laterId)),
              );
              expect(traces).toContain(`aborting run: sessionId=${firstId}`);
              expect(traces).not.toContain(`aborting run: sessionId=${laterId}`);
            } else {
              expect(traces).toContainEqual({
                runId: firstId,
                stream: "lifecycle",
                data: expect.objectContaining({ status: "cancelled", stopReason: "delete" }),
              });
              expect(traces).not.toContainEqual(expect.objectContaining({ runId: laterId }));
            }
            console.info(
              "deletion authority evidence",
              JSON.stringify({
                owner,
                transition,
                rejection: String(rejection),
                laterCancelled: wasLaterCancelled(),
                traces,
              }),
            );
            proofCompleted = true;
          } finally {
            await cleanup();
            await Promise.allSettled([draining]);
          }
        });
        if (transition === "revoked") {
          await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        } else {
          await operation;
        }
        expect(proofCompleted).toBe(true);
      } finally {
        await cleanup();
        unsubscribe();
      }
    });
  },
);
