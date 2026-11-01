import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { baseParams, createPreparedReplyTurn } from "./get-reply-run.test-support.js";

describe("bot-sender reply guidance", () => {
  it.each(["Acknowledged.", "NO_REPLY", "Can you help diagnose the failing build?"])(
    "permits silence without discarding an allowed bot message: %s",
    async (body) => {
      const prepared = await prepareReplyRunContext(
        baseParams({
          cfg: { agents: { defaults: { silentReply: { group: "allow" } } } },
          opts: { sourceReplyDeliveryMode: "message_tool_only" },
          ...createPreparedReplyTurn(body, {
            Provider: "discord",
            ChatType: "group",
            InboundEventKind: "user_request",
            SenderIsBot: true,
            WasMentioned: false,
          }),
        }),
      );
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") {
        throw new Error("bot turn was discarded");
      }
      const prompt = prepared.buildPromptBodies({});
      expect(prepared.terminalReplyExpectation).toBe("optional");
      expect(prompt.queuedBody).toBe(body);
      expect(prompt.currentInboundContext?.text).toContain("Default: stay silent.");
      expect(prompt.currentInboundContext?.text).toContain(
        "Only respond if you have something useful",
      );
      expect(prompt.currentInboundContext?.text).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
      expect(prompt.transcriptBody).toBe(body);
    },
  );

  it.each([
    ["explicit bot request", true, true, "allow"],
    ["required bot request", true, false, "disallow"],
    ["human request", false, false, "allow"],
  ] as const)(
    "keeps visible replies available for %s",
    async (_label, SenderIsBot, WasMentioned, group) => {
      const body = "Please summarize the build failure.";
      const prepared = await prepareReplyRunContext(
        baseParams({
          cfg: { agents: { defaults: { silentReply: { group } } } },
          opts: { sourceReplyDeliveryMode: "message_tool_only" },
          ...createPreparedReplyTurn(body, {
            Provider: "discord",
            ChatType: "group",
            InboundEventKind: "user_request",
            SenderIsBot,
            WasMentioned,
            MentionSource: WasMentioned ? "explicit_bot" : "none",
          }),
        }),
      );
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") {
        throw new Error("allowed conversation was discarded");
      }
      const prompt = prepared.buildPromptBodies({});
      expect(prompt.queuedBody).toBe(body);
      expect(prompt.currentInboundContext?.text).toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
    },
  );
});
