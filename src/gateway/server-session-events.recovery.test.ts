import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  listAccessorSessionEntriesReadOnlyMock,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  projectChatDisplayMessageMock,
  runtimeConfigState,
  sessionRow,
} from "./server-session-events.test-support.js";

describe("live failed-attempt presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectChatDisplayMessageMock.mockImplementation(projectChatDisplayMessage);
    listAccessorSessionEntriesReadOnlyMock.mockReturnValue([]);
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(undefined);
    loadGatewaySessionEntryReadOnlyMock.mockReturnValue({ entry: undefined, storePath: "" });
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(undefined);
    readSessionMessageByIdAsyncMock.mockReset();
    runtimeConfigState.value = {};
    sessionRow.key = "agent:main:main";
  });

  it.each(["missing", "rebuilding", "overloaded", "quoted reply"])(
    "invalidates broad and targeted history when the committed row needs page reconciliation: %s",
    async (kind) => {
      if (kind === "missing") {
        readSessionMessageByIdAsyncMock.mockResolvedValueOnce({ found: false, oversized: false });
      } else if (kind === "quoted reply") {
        readSessionMessageByIdAsyncMock.mockResolvedValueOnce({
          found: true,
          oversized: false,
          seq: 2,
          message: { role: "user", content: "Quoted reply", __openclaw: { replyToId: "original" } },
        });
      } else {
        readSessionMessageByIdAsyncMock.mockRejectedValueOnce(
          kind === "overloaded"
            ? new WorkerTaskError("reader overloaded", "overloaded")
            : new SessionTranscriptProjectionUnavailableError("sess-main"),
        );
      }
      const { broadcastToConnIds, handler } = createHandler(
        false,
        true,
        () => new Set(["targeted"]),
      );
      const outcome = await handler({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/canonical-update.sqlite",
        },
        messageId: "removed-id",
        message: { role: "assistant", content: "stale queued content" },
      });
      expect(outcome).toBe(kind === "rebuilding" || kind === "overloaded" ? false : undefined);
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: "agent:main:main", phase: "message" }),
        new Set(["conn-1", "targeted"]),
        expect.objectContaining({ prepareSessionProjection: expect.any(Function) }),
      );
      expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toHaveProperty("message");
      expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
    },
  );

  it("reports failed publication when the fallback cursor read is overloaded", async () => {
    readSessionMessageCountAsyncMock.mockRejectedValueOnce(
      new WorkerTaskError("reader overloaded", "overloaded"),
    );
    const { broadcastToConnIds, handler } = createHandler(false);
    const outcome = await handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/canonical-update.sqlite",
      },
      message: { role: "assistant", content: "Keep this reply visible." },
    });
    expect(outcome).toBe(false);
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "agent:main:main", phase: "message" }),
      expect.any(Set),
      expect.objectContaining({ prepareSessionProjection: expect.any(Function) }),
    );
  });

  it.each(["empty", "overflow", "sentinel", "overload"])(
    "does not publish a diagnostic-only %s failure while its exact run is active",
    async (kind) => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          kind === "overload" ? "503 service overloaded" : "request exceeds the available context",
        content:
          kind === "empty" || kind === "overload"
            ? []
            : [
                {
                  type: "text",
                  text:
                    kind === "overflow"
                      ? CONTEXT_OVERFLOW_ERROR_MESSAGE
                      : STREAM_ERROR_FALLBACK_TEXT,
                },
              ],
        __openclaw: { runId: "recovering-run" },
      };
      readSessionMessageByIdAsyncMock.mockResolvedValue({
        found: true,
        oversized: false,
        seq: 2,
        message,
      });
      const broadcastToConnIds = vi.fn();
      const activeRun = createActiveRun(true, true, { storePath: "/tmp/recovery.sqlite" });
      rpcSourceTesting.reset([["recovering-run", activeRun]]);
      const handler = createTranscriptUpdateBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => new Set(["broad"]) },
        sessionMessageSubscribers: { get: () => new Set(["selected"]) },
      });
      const update = {
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/recovery.sqlite",
        },
        messageId: "failed-attempt",
        message,
        runId: "recovering-run",
      };
      await handler(update);
      // Neither a message nor a broad history invalidation may leak the pending row.
      expect(broadcastToConnIds).not.toHaveBeenCalled();

      // Keeping the idempotency entry is not evidence that execution is still active.
      setRpcSourceProjectSessionActive(activeRun, false);
      broadcastToConnIds.mockClear();
      await handler(update);
      expect(broadcastToConnIds).not.toHaveBeenCalled();
      const terminal = {
        role: "custom",
        customType: "run-failed-before-reply",
        content: "Recovery exhausted.",
        details: { runId: "recovering-run" },
      };
      readSessionMessageByIdAsyncMock.mockResolvedValue({
        found: true,
        oversized: false,
        seq: 3,
        message: terminal,
      });
      await handler({ ...update, messageId: "terminal", message: terminal });
      expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual(["session.message"]);
      expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
        messageId: "terminal",
        hasActiveRun: false,
        message: { openclawRunError: { runId: "recovering-run", summary: "Recovery exhausted." } },
      });
    },
  );

  it.each(["same run", "other run", "other session"])(
    "does not infer terminal failure from projected liveness: %s",
    async (scenario) => {
      const runId = "projected-error-run";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionKey: scenario === "other session" ? "agent:main:other" : "agent:main:main",
        sessionId: scenario === "other session" ? "sess-other" : "sess-main",
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
          message: {
            role: "assistant",
            stopReason: "error",
            content: [],
            __openclaw: { runId: scenario === "other run" ? "settled-error-run" : runId },
          },
        });
        expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual([]);
      } finally {
        clearAgentRunContext(runId);
      }
    },
  );
});
