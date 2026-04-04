import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageThreadCommands } from "./register.thread.js";

function createHelpers(runMessageAction: MessageCliHelpers["runMessageAction"]): MessageCliHelpers {
  return {
    withMessageBase: (command) => command.option("--channel <channel>", "Channel"),
    withMessageTarget: (command) => command.option("-t, --target <dest>", "Target"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <dest>", "Target"),
    runMessageAction,
  };
}

describe("registerMessageThreadCommands", () => {
  const runMessageAction = vi.fn(
    async (_action: string, _opts: Record<string, unknown>) => undefined,
  );

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "topic-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "topic-chat", label: "Topic chat" }),
            actions: {
              resolveCliActionRequest: ({
                action,
                args,
              }: {
                action: string;
                args: Record<string, unknown>;
              }) => {
                if (action !== "thread-create") {
                  return null;
                }
                const { threadName, ...rest } = args;
                return {
                  action: "topic-create",
                  args: {
                    ...rest,
                    name: threadName,
                  },
                };
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
    runMessageAction.mockClear();
  });

  it("routes plugin-remapped thread create actions through channel hooks", async () => {
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "create",
        "--channel",
        " topic-chat ",
        "-t",
        "room-1",
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      "topic-create",
      expect.objectContaining({
        channel: " topic-chat ",
        target: "room-1",
        name: "Build Updates",
        message: "hello",
      }),
    );
    const remappedCall = runMessageAction.mock.calls.at(0);
    expect(remappedCall?.[1]).not.toHaveProperty("threadName");
  });

  it("keeps default thread create params when the channel does not remap the action", async () => {
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "create",
        "--channel",
        "plain-chat",
        "-t",
        "channel:123",
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      "thread-create",
      expect.objectContaining({
        channel: "plain-chat",
        target: "channel:123",
        threadName: "Build Updates",
        message: "hello",
      }),
    );
    const defaultCall = runMessageAction.mock.calls.at(0);
    expect(defaultCall?.[1]).not.toHaveProperty("name");
  });
});
