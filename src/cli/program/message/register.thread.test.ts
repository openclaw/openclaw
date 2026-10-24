import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { createMessageCliProgram, messageCliMocks } from "./command.test-support.js";

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
              resolveCliActionRequest: ({
                action,
                args,
              }: {
                action: string;
                args: Record<string, unknown>;
              }) => {
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

  async function runThreadCreate(channel: string | undefined, target: string, withMessage = false) {
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
  }

  function expectRequest(action: string, channel: string | undefined, target: string) {
    const call = messageCliMocks.command.mock.calls[0]?.[0];
    const remapped = action === "topic-create";
    expect(call).toMatchObject({
      action,
      target,
      [remapped ? "name" : "threadName"]: "Build Updates",
    });
    expect(call?.channel).toBe(channel);
    expect(call).not.toHaveProperty(remapped ? "threadName" : "name");
    return call;
  }

  it("routes plugin-remapped thread create actions through channel hooks", async () => {
    await runThreadCreate(" topic-chat ", "room-1", true);
    expect(expectRequest("topic-create", " topic-chat ", "room-1")?.message).toBe("hello");
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
    await runThreadCreate(channel, target);
    expectRequest(action, channel, target);
  });

  it("keeps default thread create params when the channel does not remap the action", async () => {
    await runThreadCreate("plain-chat", "channel:123", true);
    expect(expectRequest("thread-create", "plain-chat", "channel:123")?.message).toBe("hello");
  });
});
