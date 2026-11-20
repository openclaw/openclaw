import { describe, expect, it } from "vitest";
import {
  readWebPushCompletion,
  webPushCompletionKey,
  webPushCompletionMessageId,
} from "./web-push-completion.js";

const completion = {
  version: 1 as const,
  agentId: "agent",
  sessionKey: "agent:agent:session",
  runId: "run",
  messageId: "id:message",
  profileId: null,
};

describe("Web Push completion identity", () => {
  it("preserves exact message, session and recipient boundaries", () => {
    for (const patch of [
      { messageId: "id:newer" },
      { sessionKey: "other" },
      { profileId: "other" },
    ]) {
      expect(webPushCompletionKey({ ...completion, ...patch })).not.toBe(
        webPushCompletionKey(completion),
      );
    }
  });
  it("matches the same committed final receipt before and after history hydration", () => {
    expect(webPushCompletionMessageId({ id: null, idempotencyKey: "final" })).toBe(
      webPushCompletionMessageId({ id: "durable-row", idempotencyKey: "final" }),
    );
    expect(webPushCompletionMessageId({ id: "final", idempotencyKey: null })).not.toBe(
      webPushCompletionMessageId({ id: null, idempotencyKey: "final" }),
    );
  });
  it("keeps unknown/legacy notifications ineligible", () => {
    for (const value of [
      null,
      { url: "/chat/agent" },
      { ...completion, version: 2 },
      { ...completion, messageId: "" },
      { ...completion, runId: 123 },
      { ...completion, sessionKey: "s".repeat(513) },
    ]) {
      expect(readWebPushCompletion(value)).toBeNull();
    }
    expect(readWebPushCompletion(completion)).toEqual(completion);
  });
});
