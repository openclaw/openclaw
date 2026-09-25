// Preserve registry mocks before the cancellation entrypoints load.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import * as subagentKill from "../../agents/subagents/registry/subagent-control-kill.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { enqueueSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { registerWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import {
  handleChatAbortRequest,
  handleChatAbortRequestWithLifecycle,
} from "./chat-abort-handler.js";
import { ACTIVE_LEAF_CHANGED_ERROR_REASON } from "./chat-send-active-leaf.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import {
  createAbortTestRunState,
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

const fixture = useChatAbortRegistryFixture();
const abortSession = sessionAbortHandlers["sessions.abort"];
if (!abortSession) {
  throw new Error("sessions.abort handler is not registered");
}

it.each([false, true])(
  "preserves queued worker persistence failure with killFailure=%s",
  async (killFails) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subagent:queued-worker-failure",
      sessionId: "queued-worker-failure-session",
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    enqueueSwarmRun({
      groupId: "queued-worker-failure",
      runId: "queued-collector",
      start: vi.fn(async () => {}),
      activeRunIds: ["occupied-slot"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    await registerSubagentRun({
      runId: "queued-collector",
      childSessionKey: scope.sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "queued collector",
      cleanup: "keep",
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
    });
    await fixture.settle();
    const killFailure = new Error("collector cancellation failed");
    const workerFailure = new Error("worker cancellation persistence failed", {
      cause: new SqliteWorkerError("worker result lost", "outcome-unknown"),
    });
    const service = {};
    registerWorkerInferenceSessionControl(service, {
      reserveDrain: () => {
        throw new Error("unexpected drain reservation");
      },
      resolveTarget: () => undefined,
      captureCancel: () => ({
        runIds: ["worker-run"],
        cancel: (control) => {
          control?.assertCurrent?.();
          control?.onCancelled?.("worker-run");
          return Promise.reject(workerFailure);
        },
      }),
    });
    const active = createActiveRun(scope.sessionKey, scope);
    const context = createChatAbortContext({
      getRuntimeConfig,
      workerEnvironmentService: service,
      chatAbortControllers: new Map([["worker-run", active]]),
    });
    const kill = vi
      .spyOn(subagentKill, "killSubagentRunAdmin")
      .mockImplementationOnce(async (params, control) => {
        control?.beforeSessionKill?.();
        if (killFails) {
          throw killFailure;
        }
        const result = { found: false, killed: false } as const;
        params.onResult?.(result);
        return result;
      });
    const respond = vi.fn();
    try {
      const pending = invokeChatAbortHandler({
        handler: (options) =>
          handleChatAbortRequestWithLifecycle(options, { cascadeDescendants: true }),
        context,
        request: { sessionKey: scope.sessionKey },
        client: { connect: { scopes: ["operator.admin"] } },
        respond,
      });
      if (killFails) {
        await expect(pending).rejects.toMatchObject({ errors: [killFailure, workerFailure] });
      } else {
        await expect(pending).rejects.toBe(workerFailure);
      }
      expect(active.controller.signal.aborted).toBe(true);
      expect(kill).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  },
);

it.each([
  "run",
  "session",
  "stop",
  "stop-revoked",
  "stop-leaf",
  "sessions",
  "queued",
  "terminal",
  "revoked",
] as const)("reports the failed SQLite append through %s cancellation", async (route) => {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:subagent:save-warning",
    sessionId: "save-warning-session",
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
  openOpenClawAgentDatabase(scope).db.exec(
    "CREATE TRIGGER reject_abort_reply BEFORE INSERT ON transcript_events " +
      "WHEN json_extract(NEW.event_json, '$.message.openclawAbort.runId') = 'run-save-failure' " +
      "BEGIN SELECT RAISE(ABORT, 'fixture transcript write failed'); END",
  );
  const runId = "run-save-failure";
  const active: ChatAbortControllerEntry = createActiveRun(scope.sessionKey, scope);
  const refusal = new SessionMutationAuthorizationChangedError({
    code: "FORBIDDEN",
    message: "terminal authority changed",
    details: { reason: "fixture-revocation" },
  });
  const assertCurrent = () => {
    if (active.controller.signal.aborted) {
      if (route === "stop-revoked") {
        throw refusal;
      }
      if (route === "stop-leaf") {
        throw new Error(ACTIVE_LEAF_CHANGED_ERROR_REASON);
      }
    }
  };
  const terminalFailure = route === "terminal" || route === "revoked";
  if (terminalFailure) {
    const error = route === "revoked" ? refusal : new Error("terminal write failed");
    active.projectSessionTerminalPersistence = Promise.reject(error);
    void active.projectSessionTerminalPersistence.catch(() => {});
  }
  if (route === "queued") {
    enqueueSwarmRun({
      groupId: "save-warning",
      runId: "queued-save-warning",
      start: vi.fn(async () => {}),
      activeRunIds: ["occupied-slot"],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    await registerSubagentRun({
      runId: "queued-save-warning",
      childSessionKey: scope.sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "queued collector",
      cleanup: "keep",
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
    });
    await fixture.settle();
  }
  const respond = vi.fn();
  const context = createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map([[runId, active]]),
    chatRunState: createAbortTestRunState([[runId, { buffer: "Already streamed reply" }]]),
  });
  const pending = invokeChatAbortHandler({
    handler:
      route === "stop" || route === "stop-revoked" || route === "stop-leaf"
        ? (options) =>
            handleDirectExternalChatSend({
              ...options,
              sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent },
              params: {
                sessionKey: scope.sessionKey,
                message: "/stop",
                idempotencyKey: "stop-warning",
              },
            })
        : route === "sessions" || route === "queued" || terminalFailure
          ? (options) =>
              abortSession({
                ...options,
                params: { key: scope.sessionKey, ...(route === "queued" ? {} : { runId }) },
              })
          : handleChatAbortRequest,
    context,
    client: { connId: "save-warning-owner", connect: { scopes: ["operator.admin"] } },
    request: { sessionKey: scope.sessionKey, ...(route === "run" ? { runId } : {}) },
    respond,
  });
  if (terminalFailure || route === "stop-revoked") {
    await expect(pending).rejects.toThrow(/terminal.*could not be saved to history/);
    if (route === "revoked" || route === "stop-revoked") {
      await expect(pending).rejects.toMatchObject({
        error: { code: "FORBIDDEN", details: { reason: "fixture-revocation" } },
      });
    }
  } else if (route === "stop-leaf") {
    await pending;
    expect(respond.mock.lastCall?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: ACTIVE_LEAF_CHANGED_ERROR_REASON },
      message: expect.stringContaining("could not be saved to history"),
    });
  } else {
    await pending;
    expect(respond.mock.lastCall?.[2]).toBeUndefined();
    expect(respond.mock.lastCall?.[0]).toBe(true);
    expect(respond.mock.lastCall?.[1]).toMatchObject({
      warning: expect.stringContaining("could not be saved to history"),
    });
  }
  expect(active.controller.signal.aborted).toBe(true);
  expect(await loadTranscriptEvents(scope)).not.toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ idempotencyKey: "run-save-failure:assistant" }),
    }),
  );
});
