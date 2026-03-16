import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  __testing,
  clearPluginCommands,
  executePluginCommand,
  getPluginCommandSpecs,
  listPluginCommands,
  registerPluginCommand,
} from "./commands.js";
import { setActivePluginRegistry } from "./runtime.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
});

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it("rejects malformed runtime command shapes", () => {
    const invalidName = registerPluginCommand(
      "demo-plugin",
      // Runtime plugin payloads are untyped; guard at boundary.
      {
        name: undefined as unknown as string,
        description: "Demo",
        handler: async () => ({ text: "ok" }),
      },
    );
    expect(invalidName).toEqual({
      ok: false,
      error: "Command name must be a string",
    });

    const invalidDescription = registerPluginCommand("demo-plugin", {
      name: "demo",
      description: undefined as unknown as string,
      handler: async () => ({ text: "ok" }),
    });
    expect(invalidDescription).toEqual({
      ok: false,
      error: "Command description must be a string",
    });
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "  demo_cmd  ",
      description: "  Demo command  ",
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });
    expect(listPluginCommands()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        pluginId: "demo-plugin",
      },
    ]);
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });

  it("supports provider-specific native command aliases", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "voice",
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
      description: "Demo command",
      handler: async () => ({ text: "ok" }),
    });

    expect(result).toEqual({ ok: true });
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "talkvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs("discord")).toEqual([
      {
        name: "discordvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs("telegram")).toEqual([
      {
        name: "talkvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs("slack")).toEqual([]);
  });

  it("resolves Discord DM command bindings with the user target prefix intact", () => {
    expect(
      __testing.resolveBindingConversationFromCommand({
        channel: "discord",
        from: "discord:1177378744822943744",
        to: "slash:1177378744822943744",
        accountId: "default",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "default",
      conversationId: "user:1177378744822943744",
    });
  });

  it("resolves Discord guild command bindings with the channel target prefix intact", () => {
    expect(
      __testing.resolveBindingConversationFromCommand({
        channel: "discord",
        from: "discord:channel:1480554272859881494",
        accountId: "default",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:1480554272859881494",
    });
  });

  it("resolves Telegram topic command bindings without a Telegram registry entry", () => {
    expect(
      __testing.resolveBindingConversationFromCommand({
        channel: "telegram",
        from: "telegram:group:-100123",
        to: "telegram:group:-100123:topic:77",
        accountId: "default",
      }),
    ).toEqual({
      channel: "telegram",
      accountId: "default",
      conversationId: "-100123",
      threadId: 77,
    });
  });

  it("does not resolve binding conversations for unsupported command channels", () => {
    expect(
      __testing.resolveBindingConversationFromCommand({
        channel: "slack",
        from: "slack:U123",
        to: "C456",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("does not expose binding APIs to plugin commands on unsupported channels", async () => {
    const handler = async (ctx: {
      requestConversationBinding: (params: { summary: string }) => Promise<unknown>;
      getCurrentConversationBinding: () => Promise<unknown>;
      detachConversationBinding: () => Promise<unknown>;
    }) => {
      const requested = await ctx.requestConversationBinding({
        summary: "Bind this conversation.",
      });
      const current = await ctx.getCurrentConversationBinding();
      const detached = await ctx.detachConversationBinding();
      return {
        text: JSON.stringify({
          requested,
          current,
          detached,
        }),
      };
    };
    registerPluginCommand(
      "demo-plugin",
      {
        name: "bindcheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
      },
      { pluginRoot: "/plugins/demo-plugin" },
    );

    const result = await executePluginCommand({
      command: {
        name: "bindcheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
        pluginId: "demo-plugin",
        pluginRoot: "/plugins/demo-plugin",
      },
      channel: "slack",
      senderId: "U123",
      isAuthorizedSender: true,
      commandBody: "/bindcheck",
      config: {} as never,
      from: "slack:U123",
      to: "C456",
      accountId: "default",
    });

    expect(result.text).toBe(
      JSON.stringify({
        requested: {
          status: "error",
          message: "This command cannot bind the current conversation.",
        },
        current: null,
        detached: { removed: false },
      }),
    );
  });
});
