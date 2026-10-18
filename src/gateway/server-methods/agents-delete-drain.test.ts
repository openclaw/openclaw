import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.entry.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionPatches from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionInventory from "../../config/sessions/session-entry-read-runtime.js";
import { CronService } from "../../cron/service.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import { trackSessionControllerSourceWork } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceForGateway,
  isRpcSourceRegistered,
} from "../../sessions/session-controller.rpc-sources.js";
import * as deletionJournals from "../../state/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
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

afterEach(() => vi.restoreAllMocks());

it.each(["commits", "rolls back", "retries failed rollback persistence"] as const)(
  "%s deletion after its refused terminal projection and raw execution have settled",
  async (outcome) => {
    await withOpenClawTestState({ label: "deletion-terminal-drain" }, async (state) => {
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
      const cleanupError = Object.assign(new Error("EACCES: workspace is unreadable"), {
        code: "EACCES",
      });
      const sessionKey = "agent:doomed:dashboard:ending";
      const sessionId = "ending-session";
      const runId = "ending-run";
      await replaceSessionEntry(
        { agentId: "doomed", sessionKey },
        { sessionId, lifecycleRunId: runId, updatedAt: 1 },
      );
      const scheduler = createTestGatewayScheduler();
      const cron = new CronService({
        scheduler,
        storePath: state.statePath("cron/jobs.json"),
        cronEnabled: false,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const context = createDirectChatContext({ cron, getRuntimeConfig });
      const subscriptions = startGatewayEventSubscriptions({
        scheduler,
        signal: new AbortController().signal,
        log: context.logGateway,
        broadcast: context.broadcast,
        broadcastToConnIds: context.broadcastToConnIds,
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState: context.chatRunState,
        toolEventRecipients: context.chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        restartRecoveryCandidates: new Map(),
        refreshConnectedUserProfiles: vi.fn(),
      });
      const target = captureSessionTarget({
        storeScope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
          agentId: "doomed",
        }),
        sessionKey,
        incarnation: sessionId,
        agentId: "doomed",
      });
      const registration = registerChatAbortController({
        target,
        agentId: "doomed",
        sessionKey,
        sessionId,
        runId,
        kind: "agent",
        timeoutMs: 60_000,
      });
      if (!registration.entry) {
        throw new Error("Expected an active run registration");
      }
      const entry = registration.entry;
      registration.initializeTiming();
      expect(registration.markExecutionStarted()).toBe(true);
      const aborted = createDeferred();
      const terminalSettled = createDeferred();
      const finishExecution = createDeferred();
      let terminalPersistence: Promise<void> | undefined;
      registration.controller.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      const execution = (async () => {
        await aborted.promise;
        emitAgentEvent({
          runId,
          sessionId,
          sessionKey,
          agentId: "doomed",
          stream: "lifecycle",
          data: { phase: "error", aborted: true, stopReason: "aborted", endedAt: 2_000 },
        });
        registration.cleanup();
        terminalPersistence = entry.adapter.projectSessionTerminalPersistence;
        await terminalPersistence?.catch(() => {});
        terminalSettled.resolve();
        await finishExecution.promise;
      })();
      trackSessionControllerSourceWork(entry.input, execution);
      const deleting = deleteGatewayAgent("doomed", true, context);
      const deletionResult = Promise.allSettled([deleting]);
      try {
        await awaitGateBeforeSettlement(
          terminalSettled.promise,
          deleting,
          "deletion skipped cancellation",
        );
        expect(terminalPersistence).toBeInstanceOf(Promise);
        expect(getRpcSourceForGateway(runId, getGatewayContextResolver(entry.input), target)).toBe(
          entry,
        );
        expect(getRuntimeConfig().agents?.entries?.doomed).toBeDefined();
        await expect(
          patchSessionEntryCore({ agentId: "doomed", sessionKey }, () => ({ label: "late write" })),
        ).rejects.toThrow("deletion is draining active work");
        if (outcome !== "commits") {
          const lstat = fs.lstat;
          vi.spyOn(fs, "lstat").mockImplementation((...args) => {
            if (args[0] === state.path("doomed")) {
              return Promise.reject(cleanupError);
            }
            return lstat(...args);
          });
        }
        const persistenceError = new Error("terminal persistence failed");
        const failedReplay =
          outcome === "retries failed rollback persistence"
            ? vi
                .spyOn(sessionPatches, "applySessionEntryTargetOperation")
                .mockRejectedValueOnce(persistenceError)
            : undefined;
        finishExecution.resolve();
        await execution;
        if (outcome !== "commits") {
          await expect(deleting).rejects.toBe(failedReplay ? persistenceError : cleanupError);
          expect(getRuntimeConfig().agents?.entries?.doomed).toBeDefined();
          if (failedReplay) {
            failedReplay.mockRestore();
            await expect(
              patchSessionEntryCore({ agentId: "doomed", sessionKey }, () => ({
                label: "blocked",
              })),
            ).rejects.toThrow("deletion cleanup is still pending");
            const journal = await deletionJournals.readAgentDeletionJournalAsync("doomed");
            if (!journal) {
              throw new Error("Failed replay must retain deletion custody");
            }
            await withAgentDeletion("doomed", async (begin) => {
              const deletion = await begin(journal);
              await deletion.rollback();
            });
          }
          expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toBeUndefined();
          const restored = loadSessionEntry({ agentId: "doomed", sessionKey });
          expect(restored).toMatchObject({ status: "killed", endedAt: 2_000, lastRunId: runId });
          expect(restored?.lifecycleRunId).toBeUndefined();
          await expect(
            patchSessionEntryCore({ agentId: "doomed", sessionKey }, () => ({ label: "reopened" })),
          ).resolves.toMatchObject({ label: "reopened" });
        } else {
          await expect(deleting).resolves.toMatchObject({ ok: true, agentId: "doomed" });
          expect(getRuntimeConfig().agents?.entries?.doomed).toBeUndefined();
        }
        expect(isRpcSourceRegistered(entry)).toBe(false);
      } finally {
        aborted.resolve();
        finishExecution.resolve();
        await execution;
        await deletionResult;
        registration.cleanup();
        await subscriptions.agentUnsub();
        subscriptions.heartbeatUnsub();
        subscriptions.transcriptUnsub();
        subscriptions.lifecycleUnsub();
      }
    });
  },
);

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
      const inventoryError = new Error("inventory failed");
      const inventory = vi
        .spyOn(sessionInventory, "readSessionEntrySummariesInWorker")
        .mockRejectedValueOnce(inventoryError);
      const handle = createEmbeddedRunHandle({ abort: vi.fn() });
      setActiveEmbeddedRun("pending", handle, scope.sessionKey, undefined, "doomed");
      try {
        await expect(
          deleteGatewayAgent("doomed", false, createDirectChatContext({ getRuntimeConfig })),
        ).rejects.toBe(inventoryError);
        expect(handle.abort).not.toHaveBeenCalled();
      } finally {
        clearActiveEmbeddedRun("pending", handle, scope.sessionKey);
      }
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
    let active: SessionEffectRef | undefined;
    let pending: Promise<SessionEffectRef> | undefined;
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
        assertAllowed: () => {},
      };
      active = await beginSessionEffect({ ...admission, onInterrupt: activeInterrupted });
      pending = beginSessionEffect({ ...admission, onInterrupt: pendingInterrupted });
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
      const admission = await beginSessionEffect({
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
