import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { createMessageCliProgram, messageCliMocks } from "./command.test-support.js";

type ActionRequest = { action: string; args: Record<string, unknown> };

describe("registerMessageThreadCommands", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "topic-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "topic-chat", label: "Topic chat" }),
            actions: {
              resolveCliActionRequest: ({ action, args }: ActionRequest) => {
                const { threadName, ...rest } = args;
                return action === "thread-create"
                  ? { action: "topic-create", args: { ...rest, name: threadName } }
                  : null;
              },
            },
          },
        },
        {
          pluginId: "plain-chat",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "plain-chat", label: "Plain chat" }),
        },
      ]),
    );
    messageCliMocks.command.mockClear();
  });

  it.each([
    [" topic-chat ", "room-1", "topic-create", true],
    [undefined, "topic-chat:room-1", "topic-create", false],
    ["plain-chat", "topic-chat:room-1", "thread-create", false],
    [undefined, "plain-chat:room-1", "thread-create", false],
    ["topic-chat", "plain-chat:room-1", "topic-create", false],
    ["plain-chat", "channel:123", "thread-create", true],
  ])(
    "routes channel %s and target %s to %s (message: %s)",
    async (channel, target, action, withMessage) => {
      await createMessageCliProgram("topic-chat|plain-chat").parseAsync(
        [
          "message",
          "thread",
          "create",
          ...(channel ? ["--channel", channel] : []),
          withMessage ? "-t" : "--target",
          target,
          "--thread-name",
          "Build Updates",
          ...(withMessage ? ["-m", "hello"] : []),
        ],
        { from: "user" },
      );
      const call = messageCliMocks.command.mock.calls[0]?.[0];
      const remapped = action === "topic-create";
      expect(call).toMatchObject({
        action,
        target,
        [remapped ? "name" : "threadName"]: "Build Updates",
      });
      expect(call?.channel).toBe(channel);
      expect(call).not.toHaveProperty(remapped ? "threadName" : "name");
      if (withMessage) {
        expect(call?.message).toBe("hello");
      }
    },
  );
});
