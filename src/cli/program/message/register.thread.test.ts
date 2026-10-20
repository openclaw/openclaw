// Register thread tests cover message thread command registration and option wiring.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { createMessageCliProgram, messageCliMocks } from "./command.test-support.js";

function firstMessageActionCall() {
  const options = messageCliMocks.command.mock.calls[0]?.[0];
  return options ? ([options.action, options] as const) : undefined;
}

describe("registerMessageThreadCommands", () => {
  const runMessageAction = messageCliMocks.command;

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

  async function runThreadCreateWithMessage(channel: string, target: string) {
    const message = createMessageCliProgram("topic-chat|plain-chat");

    await message.parseAsync(
      [
        "message",
        "thread",
        "create",
        "--channel",
        channel,
        "-t",
        target,
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );
  }

  it("routes plugin-remapped thread create actions through channel hooks", async () => {
    await runThreadCreateWithMessage(" topic-chat ", "room-1");

    const remappedCall = firstMessageActionCall();
    expect(remappedCall?.[0]).toBe("topic-create");
    expect(remappedCall?.[1]?.channel).toBe(" topic-chat ");
    expect(remappedCall?.[1]?.target).toBe("room-1");
    expect(remappedCall?.[1]?.name).toBe("Build Updates");
    expect(remappedCall?.[1]?.message).toBe("hello");
    expect(remappedCall?.[1]).not.toHaveProperty("threadName");
  });

  it.each([
    {
      description: "infers the action owner from a registered channel-prefixed target",
      channel: undefined,
      target: "topic-chat:room-1",
      action: "topic-create",
    },
    {
      description: "prefers an explicit channel over a conflicting target prefix",
      channel: "plain-chat",
      target: "topic-chat:room-1",
      action: "thread-create",
    },
    {
      description: "keeps prefixed channels without an action remap unchanged",
      channel: undefined,
      target: "plain-chat:room-1",
      action: "thread-create",
    },
    {
      description: "keeps an explicit action owner over a conflicting target prefix",
      channel: "topic-chat",
      target: "plain-chat:room-1",
      action: "topic-create",
    },
  ])("$description", async ({ action, channel, target }) => {
    const message = createMessageCliProgram("topic-chat|plain-chat");

    await message.parseAsync(
      [
        "message",
        "thread",
        "create",
        ...(channel ? ["--channel", channel] : []),
        "--target",
        target,
        "--thread-name",
        "Build Updates",
      ],
      { from: "user" },
    );

    const call = firstMessageActionCall();
    expect(call?.[0]).toBe(action);
    expect(call?.[1]?.channel).toBe(channel);
    expect(call?.[1]?.target).toBe(target);
    expect(call?.[1]?.[action === "topic-create" ? "name" : "threadName"]).toBe("Build Updates");
    expect(call?.[1]).not.toHaveProperty(action === "topic-create" ? "threadName" : "name");
  });

  it("keeps default thread create params when the channel does not remap the action", async () => {
    await runThreadCreateWithMessage("plain-chat", "channel:123");

    const defaultCall = firstMessageActionCall();
    expect(defaultCall?.[0]).toBe("thread-create");
    expect(defaultCall?.[1]?.channel).toBe("plain-chat");
    expect(defaultCall?.[1]?.target).toBe("channel:123");
    expect(defaultCall?.[1]?.threadName).toBe("Build Updates");
    expect(defaultCall?.[1]?.message).toBe("hello");
    expect(defaultCall?.[1]).not.toHaveProperty("name");
  });
});
