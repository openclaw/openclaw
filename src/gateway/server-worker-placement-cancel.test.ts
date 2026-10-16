import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import { handleChatSendSetupError } from "./server-methods/chat-send-dispatch-errors.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
import { cancelGatewayWorkerSessionWork } from "./server-worker-placement-cancel.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { cleanupAdmission } from "./server-worker-placement-reclaim.test-support.js";
import {
  admitWorkerStopChat,
  createWorkerStopChatContext,
} from "./server-worker-placement.test-harness.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { closeSessionSqliteDatabasesForTest } from "./session-utils.test-support.js";

it.each(["success", "failed-write", "setup-failed-write"] as const)(
  "Stop preserves canonical terminal ownership through %s",
  async (outcome) => {
    const terminalWrite = createDeferred();
    const persistenceSpy =
      outcome === "success"
        ? undefined
        : vi
            .spyOn(lifecycleState, "prepareGatewaySessionLifecycleEvent")
            .mockReturnValue(() => terminalWrite.promise);
    const state = await createOpenClawTestState({ scenario: "minimal" });
    const { root } = state;
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:terminal-stop";
    const { storePath } = await resolveGatewaySessionStoreTargetInWorker({ cfg, key: sessionKey });
    const target = { storePath, sessionKey };
    const sessionId = "terminal-stop-session";
    const runId = "terminal-stop-run";
    const entry = {
      sessionId,
      worktree: { id: "terminal-worktree", branch: "test", repoRoot: root },
      updatedAt: Date.now(),
    };
    const identity = { sessionId, sessionKey: target.sessionKey, agentId: "main" };
    const terminal = { status: "killed", lastRunId: runId, abortedLastRun: true };
    const events: Array<Record<"phase" | "status" | "aborted" | "stopReason", unknown>> = [];
    const subscriptionFixture = createSubscriptionTestFixture();
    const log = Object.assign(subscriptionFixture.log, {
      subsystem: "test-terminal",
      isEnabled: () => false,
    });
    const context = Object.assign(createWorkerStopChatContext(), {
      getRuntimeConfig: () => cfg,
      removeChatRun: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      logGateway: log,
    });
    const { chatRunState } = context;
    let subscriptions: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    let heldWriter: Promise<unknown> | undefined;
    let reclaim: Promise<unknown> | undefined;
    const writerEntered = createDeferred();
    const releaseWriter = createDeferred();
    const abortObserved = createDeferred();
    let placement = {
      ...identity,
      state: "active" as "active" | "reclaimed",
      turnClaim: null,
    };
    let reclaimEffectStarted = false;
    let active: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        events.push({
          phase: event.data.phase,
          status: event.data.status,
          aborted: event.data.aborted,
          stopReason: event.data.stopReason,
        });
      }
    });
    const admit = async (id: string) =>
      (await admitWorkerStopChat({ context, storePath, ...identity, entry, runId: id })).promise;
    try {
      await replaceSessionEntry(target, entry);
      subscriptions = startGatewayEventSubscriptions({
        ...subscriptionFixture.createParams(),
        broadcast: context.broadcast,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState,
        chatAbortControllers: context.chatAbortControllers,
        log,
        toolEventRecipients: chatRunState.toolEventRecipients,
      });
      active = await admit(runId);
      expect(active.ok).toBe(true);
      if (!active.ok) {
        throw new Error("active admission missing");
      }
      const owned = active.value;
      if (outcome !== "setup-failed-write") {
        expect(owned.activeRunAbort.markExecutionStarted()).toBe(true);
      }
      await replaceSessionEntry(target, {
        ...entry,
        lifecycleRunId: runId,
        startedAt: Date.now(),
      });
      owned.activeRunAbort.controller.signal.addEventListener(
        "abort",
        () => {
          if (outcome !== "setup-failed-write") {
            owned.cleanupAdmittedRun();
          }
          abortObserved.resolve();
        },
        { once: true },
      );
      const barriers = createGatewayWorkerPlacementReclaimBarriers({
        placements: {
          get: () => placement as never,
          getAsync: async () => placement as never,
          waitForTurnClaimRelease: async () => {},
        },
        loadSessionRuntime: async () => ({
          managedWorktrees: {
            findLiveByOwner: async () => ({
              id: "terminal-worktree",
              ownerId: target.sessionKey,
              path: root,
            }),
          },
          resolveGatewaySessionStoreTargetInWorker,
          resolveCanonicalSessionEntryFromStoreKeys,
        }),
        cancelSessionWork: async (request) => {
          heldWriter = patchSessionEntryCore(target, async () => {
            writerEntered.resolve();
            await releaseWriter.promise;
            return null;
          });
          await writerEntered.promise;
          await cancelGatewayWorkerSessionWork(context, request);
        },
        revokeSessionAuthority: vi.fn(),
      });
      reclaim = barriers.runReclaimBarrier({
        ...identity,
        begin: async () => ({ ...placement, state: "draining" }) as never,
        reclaim: async () => {
          reclaimEffectStarted = true;
          expect(loadSessionEntry(target)).toMatchObject(terminal);
          placement = { ...placement, state: "reclaimed" };
          return placement as never;
        },
      });
      await abortObserved.promise;
      expect(context.chatAbortControllers.has(runId)).toBe(true);
      expect(owned.activeRunAbort.entry?.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
      expect(reclaimEffectStarted).toBe(false);
      expect(loadSessionEntry(target)?.status).toBeUndefined();
      const late = await admit("during-terminal-write");
      expect(late.ok).toBe(false);
      expect(context.dedupe.get("chat:during-terminal-write")).toMatchObject({
        payload: { summary: "aborted" },
      });
      if (outcome === "setup-failed-write") {
        expect(owned.restartSafeAdmission).toBeUndefined();
        await handleChatSendSetupError({
          admission: owned,
          context,
          error: new Error("pre-ACK reply context failed"),
          respond: vi.fn(),
          session: { agentId: "main", clientRunId: runId, sessionKey: target.sessionKey },
          terminalizeRestartSafeAdmission: vi.fn(async () => false),
        });
        expect(context.chatAbortControllers.get(runId)).toBe(owned.activeRunAbort.entry);
        expect(reclaimEffectStarted).toBe(false);
      }
      if (outcome !== "success") {
        const rejected = expect(reclaim).rejects.toThrow("Session cancellation did not persist");
        terminalWrite.reject(new Error("terminal store unavailable"));
        releaseWriter.resolve();
        await heldWriter;
        await rejected;
        expect(reclaimEffectStarted).toBe(false);
        expect(loadSessionEntry(target)?.status).toBeUndefined();
        return;
      }
      releaseWriter.resolve();
      await heldWriter;
      await reclaim;
      expect(events.filter((event) => event.phase === "end")).toEqual([
        { phase: "end", status: "cancelled", aborted: true, stopReason: "rpc" },
      ]);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      await closeSessionSqliteDatabasesForTest();
      const persisted = loadSessionEntry({ ...target, readConsistency: "latest" });
      expect(persisted).toMatchObject(terminal);
      expect(persisted?.endedAt).toBeTypeOf("number");
      const fresh = await admit("explicit-after-terminal-stop");
      expect(fresh.ok).toBe(true);
      cleanupAdmission("explicit-after-terminal-stop", fresh);
    } finally {
      terminalWrite.resolve();
      releaseWriter.resolve();
      await heldWriter;
      await reclaim?.catch(() => {});
      cleanupAdmission(runId, active);
      unsubscribe();
      await subscriptions?.agentUnsub();
      subscriptions?.heartbeatUnsub();
      subscriptions?.transcriptUnsub();
      subscriptions?.lifecycleUnsub();
      await closeSessionSqliteDatabasesForTest();
      clearRuntimeConfigSnapshot();
      persistenceSpy?.mockRestore();
      await state.cleanup();
    }
  },
);
