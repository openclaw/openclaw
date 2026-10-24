import { afterEach, expect, it, vi } from "vitest";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createSessionEventState } from "./chat-state.test-support.ts";

function emitGatewayEvent(state: ChatPageHost, event: "session.message", payload: unknown) {
  handlePageGatewayEvent(state, { type: "event", event, payload });
}

afterEach(() => vi.restoreAllMocks());

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

it.each([
  { label: "without an envelope run id", envelope: {} },
  { label: "with a matching envelope run id", envelope: { runId: "cli-run-1" } },
])("clears the live stream when a cli assistant row persists mid-run ($label)", ({ envelope }) => {
  const currentUser = {
    role: "user",
    content: [{ type: "text", text: "Run the CLI" }],
    __openclaw: { id: "current-user", idempotencyKey: "cli-run-1:user", seq: 1 },
  };
  const persistedRow = {
    role: "assistant",
    api: "cli",
    content: [{ type: "text", text: "Partial answer" }],
    __openclaw: { id: "cli-row-1", seq: 2, idempotencyKey: "cli-assistant:cli-run-1" },
  };
  const { state } = createSessionEventState({
    chatMessages: [currentUser],
    chatRunId: "cli-run-1",
    chatStream: "Partial answer",
  });

  emitGatewayEvent(state, "session.message", {
    sessionKey: state.sessionKey,
    ...envelope,
    hasActiveRun: true,
    messageId: "cli-row-1",
    messageSeq: 2,
    message: persistedRow,
  });

  expect(state.chatStream).toBeNull();
  expect(state.chatMessages).toEqual([
    currentUser,
    {
      ...persistedRow,
      __openclaw: {
        id: "cli-row-1",
        seq: 2,
        idempotencyKey: "cli-assistant:cli-run-1",
        runId: "cli-run-1",
      },
    },
  ]);
});

it("keeps the live stream for mid-run persisted rows without cli provenance", () => {
  const currentUser = {
    role: "user",
    content: [{ type: "text", text: "Current prompt" }],
    __openclaw: { id: "current-user", idempotencyKey: "cli-run-1:user", seq: 1 },
  };
  const persistedRow = {
    role: "assistant",
    content: [{ type: "text", text: "Different answer" }],
    __openclaw: { id: "other-row", seq: 2, runId: "cli-run-1" },
  };
  const { state } = createSessionEventState({
    chatMessages: [currentUser],
    chatRunId: "cli-run-1",
    chatStream: "Partial answer",
  });

  emitGatewayEvent(state, "session.message", {
    sessionKey: state.sessionKey,
    hasActiveRun: true,
    messageId: "other-row",
    messageSeq: 2,
    message: persistedRow,
  });

  expect(state.chatStream).toBe("Partial answer");
});
