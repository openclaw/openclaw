import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { ReplyPayload } from "../types.js";
import {
  emptyConfig,
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;

describe("dispatch-owned reply scaffolding provenance", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    setDiscordTestRegistry();
    hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
    mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({
      handled: false,
      aborted: false,
    });
  });

  it("binds the actual finalized inbound context before resolving a multiline model reply", async () => {
    const conversationContext = [
      "Current message priority: high",
      "[Current message - respond to this]",
      "[Telegram] first inbound paragraph",
      "",
      "private second inbound paragraph",
      "",
      '<function_calls><invoke name="exec">private inbound XML</invoke></function_calls>',
    ].join("\n");
    const visibleReply = "First answer paragraph.\n\nSecond answer paragraph.";
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: conversationContext,
        BodyForAgent: conversationContext,
        From: "user1",
        Surface: "telegram",
        SessionKey: "agent:test:scaffolding-provenance",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({
        text: `${conversationContext}\n\n${conversationContext}\n\n${visibleReply}`,
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result.queuedFinal).toBe(true);
    expect(delivered).toEqual([expect.objectContaining({ text: visibleReply })]);
  });
});
