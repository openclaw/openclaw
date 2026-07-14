// Tests preflight handling for Telegram replies whose target context was not recovered.
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { shouldBlockUnresolvedTelegramReplyTarget } from "./get-reply-run.js";

describe("shouldBlockUnresolvedTelegramReplyTarget", () => {
  it("blocks Telegram replies when only the unsupported rich-message placeholder was recovered", () => {
    expect(
      shouldBlockUnresolvedTelegramReplyTarget({
        OriginatingChannel: "telegram",
        Provider: "telegram",
        Surface: "telegram",
        ReplyToId: "14112",
        ReplyToBody: "[unsupported Telegram rich_message received]",
      } as TemplateContext),
    ).toBe(true);
  });

  it("allows Telegram replies when the replied-to body is usable", () => {
    expect(
      shouldBlockUnresolvedTelegramReplyTarget({
        OriginatingChannel: "telegram",
        ReplyToId: "14112",
        ReplyToBody: "FLOW: Daily UK visa policy change watch",
      } as TemplateContext),
    ).toBe(false);
  });

  it("allows Telegram replies when the selected chat window contains the reply target", () => {
    expect(
      shouldBlockUnresolvedTelegramReplyTarget({
        OriginatingChannel: "telegram",
        ReplyToId: "14112",
        UntrustedStructuredContext: [
          {
            label: "Nearby reply target window",
            source: "telegram",
            type: "chat_window",
            payload: {
              relation: "selected_for_current_message",
              messages: [
                {
                  message_id: "14112",
                  body: "FLOW: Daily UK visa policy change watch",
                  is_reply_target: true,
                },
              ],
            },
          },
        ],
      } as TemplateContext),
    ).toBe(false);
  });

  it("does not block non-Telegram reply targets", () => {
    expect(
      shouldBlockUnresolvedTelegramReplyTarget({
        OriginatingChannel: "discord",
        ReplyToId: "msg-1",
        ReplyToBody: "[unsupported Telegram rich_message received]",
      } as TemplateContext),
    ).toBe(false);
  });
});
