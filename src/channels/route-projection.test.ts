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
        return parentConversationId && parentConversationId !== conversationId
          ? { to: `channel:${parentConversationId}`, threadId: conversationId }
          : { to: `channel:${conversationId}` };
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
  ["literal NaN string", " NaN ", "channel:NaN"],
  ["blank string", "  ", undefined],
  ["NaN", Number.NaN, undefined],
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

it.each([
  [
    "thread-chat",
    "thread-1",
    "room-1",
    { to: "channel:room-1", threadId: "thread-1" },
    "channel:room-1",
  ],
  ["unroutable-chat", "room-1", undefined, { to: "channel:room-1" }, "channel:room-1"],
  ["room-chat", "$thread", undefined, { to: undefined, threadId: "$thread" }, "channel:$thread"],
] as const)(
  "projects %s delivery and formatting fallbacks",
  (channel, conversationId, parentConversationId, delivery, formatted) => {
    const conversation = { channel, accountId: "work", conversationId, parentConversationId };
    expect(deliveryContextFromConversation(conversation)).toEqual({
      channel,
      accountId: "work",
      ...delivery,
    });
    expect(target(conversation)).toBe(formatted);
  },
);
