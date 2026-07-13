// Covers source_policy hook merging for source-visible reply delivery.
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const sourcePolicyEvent = {
  content: "hello",
  body: "hello",
  channel: "imessage",
  sessionKey: "agent:test:session",
  isGroup: false,
  chatType: "direct",
  sendPolicy: "allow" as const,
};

const sourcePolicyCtx = {
  channelId: "imessage",
  sessionKey: "agent:test:session",
};

describe("source_policy hook runner", () => {
  it("merges handlers to the most restrictive source delivery mode", async () => {
    const first = vi.fn().mockResolvedValue({});
    const second = vi.fn().mockResolvedValue({
      sourceReplyDeliveryMode: "message_tool_only",
      promptBody: "<read_only>hello</read_only>",
      currentInboundContext: null,
      suppressConversationContext: true,
      reason: "read-only source",
    });
    const third = vi.fn().mockResolvedValue({});
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "source_policy", handler: first },
      { hookName: "source_policy", handler: second },
      { hookName: "source_policy", handler: third },
    ]);

    const result = await runner.runSourcePolicy(sourcePolicyEvent, sourcePolicyCtx);

    expect(result).toEqual({
      sourceReplyDeliveryMode: "message_tool_only",
      promptBody: "<read_only>hello</read_only>",
      currentInboundContext: null,
      suppressConversationContext: true,
      reason: "read-only source",
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });
});
