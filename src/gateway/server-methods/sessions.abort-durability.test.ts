import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi, type MockInstance } from "vitest";
import { createMockSubsystemLogger } from "../../../test/helpers/mock-subsystem-logger.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { heartbeatNotifications } from "../../infra/heartbeat-events.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "../server-runtime-subscriptions.test-support.js";
import * as lifecycleState from "../session-lifecycle-state.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { stopSession } from "./sessions.abort-lifecycle.test-support.js";
import type { RespondFn } from "./types.js";

const log = createMockSubsystemLogger("sessions-abort-durability-test");

it.each([
  { mode: "controller", outcome: "persisted" },
  { mode: "controller-embedded-session", outcome: "persisted" },
  { mode: "embedded-run", outcome: "persisted" },
  { mode: "embedded-session", outcome: "persisted" },
  { mode: "controller", outcome: "write-failed" },
  { mode: "embedded-run", outcome: "replacement" },
  { mode: "embedded-session", outcome: "replacement" },
])(
  "sessions.abort keeps $mode acknowledgement behind its $outcome writer outcome",
  async ({ mode, outcome }) => {
    await withOpenClawTestState({ label: "abort-durability" }, async (state) => {
      // Subscriptions and session writers share the serving Gateway's state custody.
      const stateOwner = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(state.env),
        payload: {
          pid: process.pid,
          processNamespace: readGatewayLockProcessNamespace(),
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          stateDir: state.stateDir,
          role: "gateway",
        },
      });
      await using _ = {
        [Symbol.asyncDispose]: () => state.restoreEnv().finally(stateOwner.release),
      };
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const target = {
        agentId: "main",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: "agent:main:abort-durability",
      };
      const sessionId = "abort-durability-session";
      const runId = "abort-durability-run";
      const identity = { sessionKey: target.sessionKey, sessionId, agentId: target.agentId };
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const aborted = createDeferred();
      const embeddedState = {
        runId,
        isAbortable: true,
        abort: () => {
          embeddedState.isAbortable = false;
          aborted.resolve();
        },
      };
      const embedded = createEmbeddedRunHandle(embeddedState);
      const controllerTarget = captureSessionTarget({
        storeScope: target.storePath,
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        incarnation: sessionId,
      });
      const registration = mode.startsWith("controller")
        ? registerChatAbortController({
            target: controllerTarget,
            ...identity,
            runId,
            kind: "agent",
            timeoutMs: 60_000,
          })
        : undefined;
      const releaseController = registration?.entry
        ? await claimRpcSourceForTest(registration.entry)
        : undefined;
      registration?.entry?.input.claim?.operation?.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        isAbortable: () => embeddedState.isAbortable,
      });
      registration?.controller.signal.addEventListener(
        "abort",
        () => {
          embeddedState.abort();
          releaseController?.();
        },
        { once: true },
      );
      const nativeOperation = mode.startsWith("controller")
        ? registration?.entry?.input.claim?.operation
        : createReplyOperation({
            target: controllerTarget,
            ...identity,
            resetTriggered: false,
          });
      if (mode !== "controller") {
        setActiveEmbeddedRun(
          sessionId,
          embedded,
          target.sessionKey,
          undefined,
          target.agentId,
          nativeOperation,
        );
        void aborted.promise.then(() => {
          clearActiveEmbeddedRun(sessionId, embedded, target.sessionKey);
          nativeOperation?.complete();
        });
      }
      const subscriptions = startGatewayEventSubscriptions({
        ...createSubscriptionTestFixture().createParams(),
        log,
        broadcast: context.broadcast,
        broadcastToConnIds: context.broadcastToConnIds,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState: context.chatRunState,
        toolEventRecipients: context.chatRunState.toolEventRecipients,
        resolveGatewayContext: context.resolveGatewayContext,
      });
      const writerEntered = createDeferred();
      const releaseWriter = createDeferred();
      let heldWriter: Promise<unknown> | undefined;
      let request: Promise<void> | undefined;
      let replacement: Promise<void> | undefined;
      const writeFailure = new Error("terminal session write failed");
      let persistenceSpy:
        | MockInstance<typeof lifecycleState.prepareGatewaySessionLifecycleEvent>
        | undefined;
      const responseRows: Array<ReturnType<typeof loadSessionEntry>> = [];
      const respond = vi.fn<RespondFn>(() => {
        responseRows.push(loadSessionEntry(target));
      });
      const expectActiveRow = (lifecycleRunId = runId) => {
        expect(loadSessionEntry(target)).toMatchObject({ lifecycleRunId, abortedLastRun: false });
        expect(loadSessionEntry(target)?.status).toBeUndefined();
      };
      try {
        await replaceSessionEntry(target, { sessionId, updatedAt: 1_000 });
        const startEvent = {
          runId,
          sessionId,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          ts: 1_000,
          data: { phase: "start", startedAt: 1_000 },
        };
        await lifecycleState.persistGatewaySessionLifecycleEvent({
          sessionKey: target.sessionKey,
          agentId: target.agentId,
          event: startEvent,
        });
        expectActiveRow();
        heldWriter = patchSessionEntryCore(target, async () => {
          writerEntered.resolve();
          await releaseWriter.promise;
          return null;
        });
        await writerEntered.promise;
        if (outcome === "replacement") {
          replacement = lifecycleState.persistGatewaySessionLifecycleEvent({
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            event: { ...startEvent, runId: "replacement-run" },
          });
        }
        if (outcome === "write-failed") {
          persistenceSpy = vi
            .spyOn(lifecycleState, "prepareGatewaySessionLifecycleEvent")
            .mockReturnValueOnce(async () => {
              throw writeFailure;
            });
        }
        request = Promise.resolve(
          stopSession(
            target.sessionKey,
            respond,
            context,
            mode.endsWith("session") ? {} : { runId },
            null,
          ),
        );
        void request.catch(() => {});
        await aborted.promise;
        if (mode === "embedded-run") {
          clearActiveEmbeddedRun(sessionId, embedded, target.sessionKey);
        }
        await setImmediate();
        expect.soft(respond).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)?.status).toBeUndefined();
        releaseWriter.resolve();
        await heldWriter;
        await replacement;
        if (outcome === "write-failed") {
          await expect(request).rejects.toThrow(writeFailure);
          expect(respond).not.toHaveBeenCalled();
          expectActiveRow();
          return;
        }
        await request;
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          expect.objectContaining({ ok: true, status: "aborted" }),
        ]);
        if (outcome === "replacement") {
          expectActiveRow("replacement-run");
          return;
        }
        expect(responseRows[0]).toMatchObject({ status: "killed", abortedLastRun: true });
        await closeOpenClawAgentDatabasesAsync(state.root);
        closeOpenClawAgentDatabasesForTest(state.root);
        expect(loadSessionEntry({ ...target, readConsistency: "latest" })).toMatchObject({
          status: "killed",
          abortedLastRun: true,
          lastRunId: runId,
        });
        expect(loadSessionEntry(target)?.lifecycleRunId).toBeUndefined();
      } finally {
        releaseWriter.resolve();
        await heldWriter;
        await replacement;
        await request?.catch(() => {});
        clearActiveEmbeddedRun(sessionId, embedded, target.sessionKey);
        nativeOperation?.complete();
        releaseController?.();
        registration?.cleanup();
        await subscriptions.agentUnsub();
        heartbeatNotifications.onEvent = () => {};
        subscriptions.transcriptUnsub();
        subscriptions.lifecycleUnsub();
        persistenceSpy?.mockRestore();
      }
    });
  },
);
