import { afterEach, expect, it, vi } from "vitest";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createSessionEventState } from "./chat-state.test-support.ts";

function emitGatewayEvent(state: ChatPageHost, event: "session.message", payload: unknown) {
  handlePageGatewayEvent(state, { type: "event", event, payload });
}

afterEach(() => vi.restoreAllMocks());

it.each(["current-run", "other-run"])(
  "retires only the matching CLI reply when persistence precedes completion (key=%s)",
  (persistedRunId) => {
    const { state } = createSessionEventState({
      chatRunId: "current-run",
      chatStream: "CLI answer",
      chatStreamStartedAt: 100,
    });
    const message = {
      role: "assistant",
      api: "cli",
      content: [{ type: "text", text: "CLI answer" }],
      __openclaw: {
        id: "saved-cli-reply",
        seq: 2,
        runId: "current-run",
        idempotencyKey: `cli-assistant:${persistedRunId}`,
      },
    };

    emitGatewayEvent(state, "session.message", {
      sessionKey: state.sessionKey,
      hasActiveRun: true,
      messageId: "saved-cli-reply",
      messageSeq: 2,
      message,
    });

    expect(state.chatMessages).toEqual([message]);
    expect(state.chatStream).toBe(persistedRunId === "current-run" ? null : "CLI answer");
    expect(state.chatStreamStartedAt).toBe(persistedRunId === "current-run" ? null : 100);
    expect(state.chatRunId).toBe("current-run");
  },
);

it("leaves the active run assistant message on the terminal stream path", () => {
  const currentUser = {
    role: "user",
    content: [{ type: "text", text: "Current prompt" }],
    __openclaw: { id: "current-user", idempotencyKey: "current-run:user", seq: 1 },
  };
  const { state } = createSessionEventState({
    chatMessages: [currentUser],
    chatRunId: "current-run",
    chatStream: "Current partial reply",
  });

  emitGatewayEvent(state, "session.message", {
    sessionKey: state.sessionKey,
    clientRunId: "current-run",
    hasActiveRun: true,
    messageId: "current-final",
    messageSeq: 2,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Current final reply" }],
      __openclaw: { id: "current-final", seq: 2 },
    },
  });

  expect(state.chatMessages).toEqual([currentUser]);
  expect(state.chatStream).toBe("Current partial reply");
});

it.each(
  ["commentary", "tool image"].flatMap((kind) =>
    ["metadata", "conflicting envelope", "client correlation"].map((authority) => ({
      kind,
      authority,
    })),
  ),
)("checks active $kind ownership with $authority", ({ kind, authority }) => {
  const runId = "current-run";
  const currentUser = {
    role: "user",
    content: [{ type: "text", text: "Current prompt" }],
    __openclaw: { id: "current-user", idempotencyKey: `${runId}:user`, seq: 1 },
  };
  const message = {
    ...(kind === "commentary"
      ? {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Checking the repository." },
            { type: "toolCall", id: "exec-a", name: "exec", arguments: { command: "pwd" } },
          ],
        }
      : {
          role: "toolResult",
          toolCallId: "image-a",
          toolName: "read",
          content: [{ type: "image", artifactId: "image-artifact", mimeType: "image/png" }],
        }),
    __openclaw: {
      id: "current-message",
      seq: 2,
      ...(authority === "client correlation" ? {} : { runId }),
    },
  };
  const { state } = createSessionEventState({
    chatMessages: [currentUser],
    chatRunId: runId,
    chatStream: "Continuing the current reply.",
  });

  emitGatewayEvent(state, "session.message", {
    sessionKey: state.sessionKey,
    ...(authority === "conflicting envelope" ? { runId: "other-run" } : {}),
    ...(authority === "client correlation" ? { clientRunId: runId } : {}),
    hasActiveRun: true,
    messageId: message["__openclaw"].id,
    messageSeq: message["__openclaw"].seq,
    message,
  });

  expect(state.chatMessages).toEqual([currentUser, ...(authority === "metadata" ? [message] : [])]);
  expect(state.chatRunId).toBe(runId);
  expect(state.chatStream).toBe("Continuing the current reply.");
});
