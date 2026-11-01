// @vitest-environment jsdom
import { expect, it } from "vitest";
import { interruptPendingQueuedChatInput } from "./chat-history-actions.ts";
import {
  makeChatPageHost,
  input,
  sessionKey,
  sessionId,
} from "./chat-pending-inputs.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";

it("retains uncertain server custody without replaying or cancelling accepted input", async () => {
  const host = makeChatPageHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.interrupt": () => {
        throw new Error("Connection lost after the control request");
      },
    },
  });
  applyChatPendingInputs(host, {
    items: [{ ...input, state: "queued", queued: true }],
    total: 1,
    queuedCount: 1,
  });
  expect(await interruptPendingQueuedChatInput(host, `pending-input:${input.id}`)).toBe(true);
  expect(host.request.mock.calls.map(([method]) => method)).toEqual(["chat.interrupt"]);
  expect(getChatPendingInputs(host)?.queuedInputs).toMatchObject([
    { id: input.id, runId: input.runId, state: "queued" },
  ]);
  expect(host.chatError).toContain("Connection lost");
});
