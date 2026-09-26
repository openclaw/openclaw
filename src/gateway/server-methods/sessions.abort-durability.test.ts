import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import * as lifecycleState from "../session-lifecycle-state.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import type { RespondFn } from "./types.js";

const log: SubsystemLogger = {
  subsystem: "sessions-abort-durability-test",
  isEnabled: () => false,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => log,
};

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
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const target = {
        agentId: "main",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: "agent:main:abort-durability",
      };
      const sessionId = "abort-durability-session";
      const runId = "abort-durability-run";
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
      const registration = mode.startsWith("controller")
        ? registerChatAbortController({
            chatAbortControllers: context.chatAbortControllers,
            sessionKey: target.sessionKey,
            sessionId,
            agentId: target.agentId,
            runId,
            kind: "agent",
            timeoutMs: 60_000,
            isAbortable: () => embeddedState.isAbortable,
          })
        : undefined;
      registration?.markExecutionStarted();
      registration?.controller.signal.addEventListener("abort", () => embeddedState.abort(), {
        once: true,
      });
      if (mode !== "controller") {
        setActiveEmbeddedRun(sessionId, embedded, target.sessionKey);
      }
      const subscriptions = startGatewayEventSubscriptions({
        scheduler: createTestGatewayScheduler(),
        signal: new AbortController().signal,
        log,
        broadcast: context.broadcast,
        broadcastToConnIds: context.broadcastToConnIds,
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState: context.chatRunState,
        toolEventRecipients: context.chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        chatAbortControllers: context.chatAbortControllers,
        restartRecoveryCandidates: new Map(),
        refreshConnectedUserProfiles: vi.fn(),
      });
      const writerEntered = createDeferred();
      const releaseWriter = createDeferred();
      let heldWriter: Promise<unknown> | undefined;
      let request: Promise<void> | undefined;
      let replacement: Promise<void> | undefined;
      const writeFailure = new Error("terminal session write failed");
      let persistenceSpy:
        | MockInstance<typeof lifecycleState.persistGatewaySessionLifecycleEvent>
        | undefined;
      const responseRows: Array<ReturnType<typeof loadSessionEntry>> = [];
      const respond = vi.fn<RespondFn>(() => {
        responseRows.push(loadSessionEntry(target));
      });
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
        expect(loadSessionEntry(target)).toMatchObject({
          status: "running",
          lifecycleRunId: runId,
          abortedLastRun: false,
        });
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
            .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
            .mockRejectedValueOnce(writeFailure);
        }
        request = Promise.resolve(
          sessionAbortHandlers["sessions.abort"]!({
            req: { type: "req", id: "abort-durability", method: "sessions.abort" },
            params: {
              key: target.sessionKey,
              ...(mode.endsWith("session") ? {} : { runId }),
            },
            respond,
            context,
            client: null,
            isWebchatConnect: () => false,
          }),
        );
        void request.catch(() => {});
        await aborted.promise;
        await setImmediate();
        expect.soft(respond).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)?.status).toBe("running");
        releaseWriter.resolve();
        await heldWriter;
        await replacement;
        if (outcome === "write-failed") {
          await expect(request).rejects.toThrow(writeFailure);
          expect(respond).not.toHaveBeenCalled();
          expect(loadSessionEntry(target)).toMatchObject({
            status: "running",
            lifecycleRunId: runId,
            abortedLastRun: false,
          });
          return;
        }
        await request;
        expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
          true,
          expect.objectContaining({ ok: true, status: "aborted" }),
        ]);
        if (outcome === "replacement") {
          expect(loadSessionEntry(target)).toMatchObject({
            status: "running",
            lifecycleRunId: "replacement-run",
            abortedLastRun: false,
          });
          return;
        }
        expect(responseRows[0]).toMatchObject({ status: "killed", abortedLastRun: true });
        closeOpenClawAgentDatabasesForTest();
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
        registration?.cleanup();
        await subscriptions.agentUnsub();
        subscriptions.heartbeatUnsub();
        subscriptions.transcriptUnsub();
        subscriptions.lifecycleUnsub();
        persistenceSpy?.mockRestore();
      }
    });
  },
);
