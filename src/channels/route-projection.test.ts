import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ChannelMessagingAdapter } from "./plugins/types.public.js";
import {
  formatConversationTarget as target,
  deliveryContextFromConversation,
} from "./route-projection.js";

beforeEach(() => {
  const plugin = (
    id: string,
    resolveDeliveryTarget: ChannelMessagingAdapter["resolveDeliveryTarget"],
  ) => ({
    pluginId: id,
    source: "test",
    plugin: {
      ...createChannelTestPluginBase({ id, label: id }),
      messaging: { resolveDeliveryTarget },
    },
  });
  setActivePluginRegistry(
    createTestRegistry([
      plugin("room-chat", ({ conversationId, parentConversationId }) =>
        conversationId.startsWith("$")
          ? {
              to: parentConversationId ? `room:${parentConversationId}` : undefined,
              threadId: conversationId,
            }
          : { to: `room:${conversationId}` },
      ),
      plugin("thread-chat", ({ conversationId, parentConversationId }) => {
        const parent = parentConversationId?.trim();
        const child = conversationId.trim();
        return parent && parent !== child
          ? { to: `channel:${parent}`, threadId: child }
          : { to: `channel:${child}` };
      }),
      plugin("unroutable-chat", () => null),
    ]),
  );
});

it("formats plugin-defined conversation targets via channel messaging hooks", () => {
  expect(target({ channel: "room-chat", conversationId: "!room:example" })).toBe(
    "room:!room:example",
  );
  expect(
    target({
      channel: "room-chat",
      conversationId: "$thread",
      parentConversationId: "!room:example",
    }),
  ).toBe("room:!room:example");
  expect(target({ channel: "room-chat", conversationId: "  " })).toBeUndefined();
});

const ids = [
  ["fraction", 12.9, "channel:12"],
  ["negative fraction", -12.9, "channel:-12"],
  ["zero", 0, "channel:0"],
  ["negative zero", -0, "channel:0"],
  ["literal NaN string", " NaN ", "channel:NaN"],
  ["blank string", "  ", undefined],
  ["NaN", Number.NaN, undefined],
  ["positive infinity", Number.POSITIVE_INFINITY, undefined],
  ["negative infinity", Number.NEGATIVE_INFINITY, undefined],
  ["missing id", undefined, undefined],
] as const;
describe.each(["conversationId", "parentConversationId"] as const)("%s normalization", (field) => {
  it.each([...ids, ["padded string", "  12.9  ", "channel:12.9"] as const])(
    "projects %s through the plugin",
    (_label, value, expected) => {
      const result = target({ channel: "thread-chat", conversationId: "child", [field]: value });
      expect(result).toBe(
        expected ?? (field === "parentConversationId" ? "channel:child" : undefined),
      );
    },
  );
});

it("projects parent-child conversation refs through plugin delivery targets", () => {
  expect(
    deliveryContextFromConversation({
      channel: "thread-chat",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "room-1",
    }),
  ).toEqual({
    channel: "thread-chat",
    accountId: "default",
    to: "channel:room-1",
    threadId: "thread-1",
  });
});

it("falls back to generic channel targets when a plugin has no target projection", () => {
  expect(
    deliveryContextFromConversation({
      channel: "unroutable-chat",
      accountId: "default",
      conversationId: "room-1",
    }),
  ).toEqual({ channel: "unroutable-chat", accountId: "default", to: "channel:room-1" });
});

it("preserves thread-only plugin results while formatting can supply a target fallback", () => {
  const conversation = { channel: "room-chat", accountId: "work", conversationId: "$thread" };
  expect(deliveryContextFromConversation(conversation)).toEqual({
    channel: "room-chat",
    accountId: "work",
    to: undefined,
    threadId: "$thread",
  });
  expect(target(conversation)).toBe("channel:$thread");
});
