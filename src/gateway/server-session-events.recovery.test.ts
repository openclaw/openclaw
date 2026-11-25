import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { setRpcSourceProjectSessionActive } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";
import {
  createActiveRun,
  createHandler,
  createTranscriptUpdateBroadcastHandler,
  loadAccessorSessionEntryReadOnlyMock,
  readSessionMessageByIdAsyncMock as readMessage,
  readSessionMessageCountAsyncMock as readCount,
  projectChatDisplayMessageMock,
  resetSessionEventMocks,
  transcriptTarget,
} from "./server-session-events.test-support.js";

type Update = Parameters<ReturnType<typeof createTranscriptUpdateBroadcastHandler>>[0];
const target = transcriptTarget("/tmp/recovery.sqlite");
const update = (overrides: Partial<Update>): Update => ({ target, ...overrides });
const stored = (message: unknown, seq = 2) => ({ found: true, oversized: false, seq, message });
const diagnostic = (runId: string, text?: string, errorMessage?: string) => ({
  role: "assistant",
  stopReason: "error",
  content: text ? [{ type: "text", text }] : [],
  ...(errorMessage ? { errorMessage } : {}),
  __openclaw: { runId },
});

beforeEach(() => {
  resetSessionEventMocks();
  projectChatDisplayMessageMock.mockImplementation(projectChatDisplayMessage);
});

it("does not turn queued diagnostic errors into a history invalidation", async ({ signal }) => {
  const entered = createDeferred();
  const release = createDeferred();
  const visible = { role: "user", content: "visible" };
  const error = diagnostic("retry");
  loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
    sessionId: "sess-main",
    lifecycleRevision: "original",
    updatedAt: 1,
  });
  readMessage
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return stored(visible, 1);
    })
    .mockResolvedValue(stored(error));
  const { handler, broadcastToConnIds } = createHandler(false);
  const emit = (messageId: string, message: Update["message"]) =>
    handler(update({ lifecycleRevision: "original", messageId, message }));
  const executing = emit("visible", visible);
  await withinTest(entered.promise, signal);
  const first = emit("error-1", error);
  const second = emit("error-2", error);
  try {
    expect(first).not.toBe(second);
    release.resolve();
    await withinTest(Promise.all([executing, first, second]), signal);
    expect(readMessage).toHaveBeenCalledTimes(3);
    expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual(["session.message"]);
  } finally {
    release.resolve();
    await Promise.allSettled([executing, first, second]);
  }
});

const quoted = stored({ role: "user", content: "reply", __openclaw: { replyToId: "original" } });
it.each([
  ["missing", { found: false, oversized: false }, undefined],
  ["quoted reply", quoted, undefined],
  ["rebuilding", new SessionTranscriptProjectionUnavailableError("sess-main"), false],
  ["overloaded", new WorkerTaskError("reader overloaded", "overloaded"), false],
  ["cursor overloaded", new WorkerTaskError("reader overloaded", "overloaded"), false],
] as const)("reconciles %s transcript reads", async (kind, result, outcomeExpected) => {
  const cursor = kind === "cursor overloaded";
  const reader = cursor ? readCount : readMessage;
  if (result instanceof Error) {
    reader.mockRejectedValueOnce(result);
  } else {
    reader.mockResolvedValueOnce(result);
  }
  const { broadcastToConnIds, handler } = cursor
    ? createHandler(false)
    : createHandler(false, true, () => new Set(["targeted"]));
  const outcome = await handler(
    update({
      target: { ...target, storePath: "/tmp/canonical-update.sqlite" },
      ...(cursor ? {} : { messageId: "removed-id" }),
      message: { role: "assistant", content: "reply" },
    }),
  );
  expect(outcome).toBe(outcomeExpected);
  expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
    "sessions.changed",
    expect.objectContaining({ sessionKey: "agent:main:main", phase: "message" }),
    cursor ? expect.any(Set) : new Set(["conn-1", "targeted"]),
    expect.objectContaining({ prepareSessionProjection: expect.any(Function) }),
  );
  if (!cursor) {
    expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toHaveProperty("message");
    expect(readCount).not.toHaveBeenCalled();
  }
});

it.each([
  ["empty", undefined],
  ["overflow", CONTEXT_OVERFLOW_ERROR_MESSAGE],
  ["sentinel", STREAM_ERROR_FALLBACK_TEXT],
  ["overload", undefined],
])("hides pending %s diagnostics", async (kind, text) => {
  const message = diagnostic(
    "recovering-run",
    text,
    kind === "overload" ? "503 service overloaded" : "request exceeds the available context",
  );
  readMessage.mockResolvedValue(stored(message));
  const broadcastToConnIds = vi.fn();
  const activeRun = createActiveRun(true, true, { storePath: "/tmp/recovery.sqlite" });
  rpcSourceTesting.reset([["recovering-run", activeRun]]);
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["broad"]) },
    sessionMessageSubscribers: { get: () => new Set(["selected"]) },
  });
  const failedUpdate = update({
    messageId: "failed-attempt",
    message,
    runId: "recovering-run",
  });
  await handler(failedUpdate);
  expect(broadcastToConnIds).not.toHaveBeenCalled();

  // Keeping the idempotency entry is not evidence that execution is still active.
  setRpcSourceProjectSessionActive(activeRun, false);
  await handler(failedUpdate);
  expect(broadcastToConnIds).not.toHaveBeenCalled();
  const terminal = {
    role: "custom",
    customType: "run-failed-before-reply",
    content: "Recovery exhausted.",
    details: { runId: "recovering-run" },
  };
  readMessage.mockResolvedValue(stored(terminal, 3));
  await handler({ ...failedUpdate, messageId: "terminal", message: terminal });
  expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual(["session.message"]);
  expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
    messageId: "terminal",
    hasActiveRun: false,
    message: { openclawRunError: { runId: "recovering-run", summary: "Recovery exhausted." } },
  });
});

it.each(["same run", "other run", "other session"])(
  "ignores projected liveness: %s",
  async (scenario) => {
    const runId = "projected-error-run";
    const session = scenario === "other session" ? "other" : "main";
    registerAgentRunContext(runId, {
      agentId: "main",
      sessionKey: `agent:main:${session}`,
      sessionId: `sess-${session}`,
      projectSessionActive: true,
    });
    try {
      const { handler, broadcastToConnIds } = createHandler(false);
      await handler({
        sessionFile: "/tmp/sess-main.jsonl",
        sessionKey: "agent:main:main",
        messageId: "projected-failure",
        messageSeq: 3,
        // The transcript identity wins over an unrelated update envelope.
        runId,
        message: diagnostic(scenario === "other run" ? "settled-error-run" : runId),
      });
      expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual([]);
    } finally {
      clearAgentRunContext(runId);
    }
  },
);
