import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.js";
import { createIMessageTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
const loadMessage = async () => await import("./message.js");

const setRegistry = async (registry: ReturnType<typeof createTestRegistry>) => {
  const { setActivePluginRegistry } = await import("../../plugins/runtime.js");
  setActivePluginRegistry(registry);
};

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

describe("sendMessage channel normalization", () => {
  beforeEach(async () => {
    callGatewayMock.mockReset();
    vi.resetModules();
    await setRegistry(emptyRegistry);
  });

  afterEach(async () => {
    await setRegistry(emptyRegistry);
  });

  it("normalizes Teams alias", async () => {
    const { sendMessage } = await loadMessage();
    const sendMSTeams = vi.fn(async () => ({
      messageId: "m1",
      conversationId: "c1",
    }));
    await setRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: createMSTeamsPlugin({
            outbound: createMSTeamsOutbound(),
            aliases: ["teams"],
          }),
        },
      ]),
    );
    const result = await sendMessage({
      cfg: {},
      to: "conversation:19:abc@thread.tacv2",
      content: "hi",
      channel: "teams",
      deps: { sendMSTeams },
    });

    expect(sendMSTeams).toHaveBeenCalledWith("conversation:19:abc@thread.tacv2", "hi");
    expect(result.channel).toBe("msteams");
  });

  it("normalizes iMessage alias", async () => {
    const { sendMessage } = await loadMessage();
    const sendIMessage = vi.fn(async () => ({ messageId: "i1" }));
    await setRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageTestPlugin(),
        },
      ]),
    );
    const result = await sendMessage({
      cfg: {},
      to: "someone@example.com",
      content: "hi",
      channel: "imsg",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith("someone@example.com", "hi", expect.any(Object));
    expect(result.channel).toBe("imessage");
  });
});

describe("sendPoll channel normalization", () => {
  beforeEach(async () => {
    callGatewayMock.mockReset();
    vi.resetModules();
    await setRegistry(emptyRegistry);
  });

  afterEach(async () => {
    await setRegistry(emptyRegistry);
  });

  it("normalizes Teams alias for polls", async () => {
    const { sendPoll } = await loadMessage();
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1" });
    await setRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: createMSTeamsPlugin({
            aliases: ["teams"],
            outbound: createMSTeamsOutbound({ includePoll: true }),
          }),
        },
      ]),
    );

    const result = await sendPoll({
      cfg: {},
      to: "conversation:19:abc@thread.tacv2",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      channel: "Teams",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
    };
    expect(call?.params?.channel).toBe("msteams");
    expect(result.channel).toBe("msteams");
  });
});

const emptyRegistry = createTestRegistry([]);

const createMSTeamsOutbound = (opts?: { includePoll?: boolean }): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async ({ deps, to, text }) => {
    const send = deps?.sendMSTeams;
    if (!send) {
      throw new Error("sendMSTeams missing");
    }
    const result = await send(to, text);
    return { channel: "msteams", ...result };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    const send = deps?.sendMSTeams;
    if (!send) {
      throw new Error("sendMSTeams missing");
    }
    const result = await send(to, text, { mediaUrl });
    return { channel: "msteams", ...result };
  },
  ...(opts?.includePoll
    ? {
        pollMaxOptions: 12,
        sendPoll: async () => ({ channel: "msteams", messageId: "p1" }),
      }
    : {}),
});

const createMSTeamsPlugin = (params: {
  aliases?: string[];
  outbound: ChannelOutboundAdapter;
}): ChannelPlugin => ({
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    blurb: "Bot Framework; enterprise support.",
    aliases: params.aliases,
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  outbound: params.outbound,
});
