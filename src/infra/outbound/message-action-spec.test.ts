// Verifies message-action target requirements and alias detection, including
// plugin aliases only when non-standard params are present.
import { describe, expect, it, vi } from "vitest";
import {
  actionHasResourceReference,
  actionHasTarget,
  actionRequiresTarget,
} from "./message-action-spec.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", async () => ({
  getBootstrapChannelPlugin: (
    await import("./message-action-runner.test-support.js")
  ).createPinboardMessageActionBootstrapRegistryMock(),
}));

describe("actionRequiresTarget", () => {
  it.each([
    ["send", true],
    ["channel-info", true],
    ["broadcast", false],
    ["search", false],
    ["conversation-open", false],
  ])("returns %s for %s", (action, expected) => {
    expect(actionRequiresTarget(action as never)).toBe(expected);
  });
});

describe("actionHasTarget", () => {
  it.each<
    [
      action: string,
      params: Record<string, unknown>,
      ctx: { channel: string } | undefined,
      expected: boolean,
    ]
  >([
    ["send", { to: "  channel:C1  " }, undefined, true],
    ["channel-info", { channelId: "  C123  " }, undefined, true],
    ["send", { to: "   ", channelId: "" }, undefined, false],
    ["read", { messageId: "msg_123" }, { channel: "pinboard" }, true],
    ["edit", { messageId: "  msg_123  " }, undefined, true],
    ["pin", { messageId: "msg_123" }, { channel: "pinboard" }, true],
    ["unpin", { messageId: "msg_123" }, { channel: "pinboard" }, true],
    ["list-pins", { chatId: "oc_123" }, { channel: "pinboard" }, true],
    ["channel-info", { chatId: "oc_123" }, { channel: "pinboard" }, true],
    ["react", { chatGuid: "chat-guid" }, undefined, true],
    ["react", { chatIdentifier: "chat-id" }, undefined, true],
    ["react", { chatId: 42 }, undefined, true],
    ["react", { messageId: "msg_123" }, { channel: "imessage" }, true],
    ["upload-file", { chatIdentifier: "chat-id" }, { channel: "imessage" }, true],
    ["read", { messageId: "msg_123" }, undefined, false],
    ["pin", { messageId: "msg_123" }, { channel: "workspace" }, false],
    ["channel-info", { chatId: "oc_123" }, { channel: "richchat" }, false],
    ["edit", { messageId: "   " }, undefined, false],
    ["react", { chatGuid: "" }, undefined, false],
    ["react", { chatId: Number.NaN }, undefined, false],
    ["react", { chatId: Number.POSITIVE_INFINITY }, undefined, false],
    ["send", { messageId: "msg_123", chatId: 42 }, undefined, false],
  ])("resolves target presence case %# for %s %j (%j) as %s", (action, params, ctx, expected) => {
    expect(actionHasTarget(action as never, params, ctx)).toBe(expected);
  });
});

describe("actionHasResourceReference", () => {
  it.each<
    [
      action: "react" | "poll-vote" | "pin",
      params: Record<string, unknown>,
      channel: string | undefined,
      expected: boolean,
    ]
  >([
    ["react" as const, { messageId: "msg_123" }, "imessage", true],
    ["poll-vote" as const, { pollId: "poll_123" }, "imessage", true],
    ["react" as const, { chatGuid: "iMessage;+;chat0000" }, "imessage", false],
    ["react" as const, { messageId: "msg_123" }, undefined, false],
    ["pin" as const, { messageId: "msg_123" }, "pinboard", false],
  ])("classifies %s resource %j on %s as %s", (action, params, channel, expected) => {
    expect(actionHasResourceReference(action, params, { channel })).toBe(expected);
  });
});
