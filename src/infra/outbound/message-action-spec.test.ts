import { describe, expect, it } from "vitest";
import { actionHasTarget, actionRequiresTarget } from "./message-action-spec.js";

describe("actionRequiresTarget", () => {
  it.each([
    ["send", true],
    ["channel-info", true],
    ["broadcast", false],
    ["search", false],
  ])("returns %s for %s", (action, expected) => {
    expect(actionRequiresTarget(action as never)).toBe(expected);
  });
});

describe("actionHasTarget", () => {
  it("detects canonical target fields", () => {
    expect(actionHasTarget("send", { to: "  channel:C1  " })).toBe(true);
    expect(actionHasTarget("channel-info", { channelId: "  C123  " })).toBe(true);
    expect(actionHasTarget("send", { to: "   ", channelId: "" })).toBe(false);
  });

  it("detects alias targets for message and chat actions", () => {
    expect(actionHasTarget("read", { messageId: "msg_123" }, { channel: "feishu" })).toBe(true);
    expect(actionHasTarget("edit", { messageId: "  msg_123  " })).toBe(true);
    expect(actionHasTarget("pin", { messageId: "msg_123" }, { channel: "feishu" })).toBe(true);
    expect(actionHasTarget("unpin", { messageId: "msg_123" }, { channel: "feishu" })).toBe(true);
    expect(actionHasTarget("list-pins", { chatId: "oc_123" }, { channel: "feishu" })).toBe(true);
    expect(actionHasTarget("channel-info", { chatId: "oc_123" }, { channel: "feishu" })).toBe(true);
    expect(actionHasTarget("react", { chatGuid: "chat-guid" })).toBe(true);
    expect(actionHasTarget("react", { chatIdentifier: "chat-id" })).toBe(true);
    expect(actionHasTarget("react", { chatId: 42 })).toBe(true);
  });

  it("scopes Feishu-only aliases to Feishu", () => {
    expect(actionHasTarget("read", { messageId: "msg_123" })).toBe(false);
    expect(actionHasTarget("pin", { messageId: "msg_123" }, { channel: "slack" })).toBe(false);
    expect(actionHasTarget("channel-info", { chatId: "oc_123" }, { channel: "discord" })).toBe(
      false,
    );
  });

  it("rejects blank and non-finite alias targets", () => {
    expect(actionHasTarget("edit", { messageId: "   " })).toBe(false);
    expect(actionHasTarget("react", { chatGuid: "" })).toBe(false);
    expect(actionHasTarget("react", { chatId: Number.NaN })).toBe(false);
    expect(actionHasTarget("react", { chatId: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("ignores alias fields for actions without alias target support", () => {
    expect(actionHasTarget("send", { messageId: "msg_123", chatId: 42 })).toBe(false);
  });
});
