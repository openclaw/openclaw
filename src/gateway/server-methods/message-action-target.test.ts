import { describe, expect, it, vi } from "vitest";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { prepareGatewayMessageActionTarget } from "./message-action-target.js";

function chatroomPlugin(resolveTarget = vi.fn()): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "chatroom",
      capabilities: { chatTypes: ["group"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
    }),
    actions: {
      describeMessageTool: () => ({ actions: ["read"] }),
      handleAction: async () => ({ content: [], details: {} }),
    },
    messaging: { targetResolver: { looksLikeId: () => false, resolveTarget } },
  };
}

describe("prepareGatewayMessageActionTarget", () => {
  it("resolves an operator's unresolved action target with the loaded plugin", async () => {
    // A runtime-free CLI adapter forwards names and mentions for the Gateway's plugin.
    const resolveTarget = vi.fn(async ({ input }: { input: string }) =>
      input === "#general" ? { to: "channel:C42", kind: "group" as const } : null,
    );
    const plugin = chatroomPlugin(resolveTarget);
    const prepare = (conversationReadOrigin: "direct-operator" | "delegated") => {
      const actionParams: Record<string, unknown> = { to: "#general", limit: 1 };
      return prepareGatewayMessageActionTarget({
        cfg: {},
        channel: "chatroom",
        plugin,
        action: "read",
        actionParams,
        canonicalAction: false,
        conversationReadOrigin,
      }).then(() => actionParams);
    };

    await expect(prepare("direct-operator")).resolves.toMatchObject({ to: "channel:C42" });
    // Agent-runtime callers resolved their target before the request; it is not rewritten.
    await expect(prepare("delegated")).resolves.toMatchObject({ to: "#general" });
  });
});
