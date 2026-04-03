import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { createRuntimeChannel } from "./runtime/runtime-channel.js";

describe("runtime channel outbound lane delivery", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("delivers rich payloads through a normalized lane ref", async () => {
    const sendText = vi.fn(async () => ({
      channel: "telegram",
      messageId: "message-1",
      chatId: "-10099",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
          source: "test",
        },
      ]),
    );

    const runtimeChannel = createRuntimeChannel();
    const results = await runtimeChannel.outbound.sendToLane({
      cfg: {} as never,
      lane: {
        channel: "telegram",
        to: "-10099",
        accountId: "default",
        threadId: 77,
      },
      payload: { text: "hello lane" },
    });

    expect(results).toEqual([
      expect.objectContaining({
        channel: "telegram",
        messageId: "message-1",
      }),
    ]);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {} as never,
        to: "-10099",
        text: "hello lane",
        accountId: "default",
        threadId: 77,
      }),
    );
  });

  it("uses the sender DM lane when delivering a private reply", async () => {
    const sendText = vi.fn(async () => ({
      channel: "slack",
      messageId: "message-2",
      channelId: "D123",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
          source: "test",
        },
      ]),
    );

    const runtimeChannel = createRuntimeChannel();
    const results = await runtimeChannel.outbound.sendToActorDm({
      cfg: {} as never,
      actor: {
        channel: "slack",
        id: "U123",
        accountId: "default",
        dmLane: {
          channel: "slack",
          to: "D123",
          accountId: "default",
        },
      },
      payload: { text: "hello dm" },
    });

    expect(results).toEqual([
      expect.objectContaining({
        channel: "slack",
        messageId: "message-2",
      }),
    ]);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "D123",
        text: "hello dm",
        accountId: "default",
      }),
    );
  });
});
