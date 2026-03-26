import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  __testing,
  clearPluginCommands,
  executePluginCommand,
  getPluginCommandSpecs,
  listPluginCommands,
  matchPluginCommand,
  registerPluginCommand,
} from "./commands.js";
import { setActivePluginRegistry } from "./runtime.js";

type CommandsModule = typeof import("./commands.js");

const commandsModuleUrl = new URL("./commands.ts", import.meta.url).href;

async function importCommandsModule(cacheBust: string): Promise<CommandsModule> {
  return (await import(`${commandsModuleUrl}?t=${cacheBust}`)) as CommandsModule;
}

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
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

    const invalidRequiredGatewayScopes = registerPluginCommand("demo-plugin", {
      name: "secure",
      description: "Secure command",
      requiredGatewayScopes: ["operator.nope" as never],
      handler: async () => ({ text: "ok" }),
    });
    expect(invalidRequiredGatewayScopes).toEqual({
      ok: false,
      error: 'Command requiredGatewayScopes contains unknown scope "operator.nope"',
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

  it("shares plugin commands across duplicate module instances", async () => {
    const first = await importCommandsModule(`first-${Date.now()}`);
    const second = await importCommandsModule(`second-${Date.now()}`);

    first.clearPluginCommands();

    expect(
      first.registerPluginCommand("demo-plugin", {
        name: "voice",
        nativeNames: {
          telegram: "voice",
        },
        description: "Voice command",
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({ ok: true });

    expect(second.getPluginCommandSpecs("telegram")).toEqual([
      {
        name: "voice",
        description: "Voice command",
        acceptsArgs: false,
      },
    ]);
    expect(second.matchPluginCommand("/voice")).toMatchObject({
      command: expect.objectContaining({
        name: "voice",
        pluginId: "demo-plugin",
      }),
    });

    second.clearPluginCommands();
  });

  it("matches provider-specific native aliases back to the canonical command", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "voice",
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
      description: "Demo command",
      acceptsArgs: true,
      handler: async () => ({ text: "ok" }),
    });

    expect(result).toEqual({ ok: true });
    expect(matchPluginCommand("/talkvoice now")).toMatchObject({
      command: expect.objectContaining({ name: "voice", pluginId: "demo-plugin" }),
      args: "now",
    });
    expect(matchPluginCommand("/discordvoice now")).toMatchObject({
      command: expect.objectContaining({ name: "voice", pluginId: "demo-plugin" }),
      args: "now",
    });
  });

  it("rejects provider aliases that collide with another registered command", () => {
    expect(
      registerPluginCommand("demo-plugin", {
        name: "voice",
        nativeNames: {
          telegram: "pair_device",
        },
        description: "Voice command",
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({ ok: true });

    expect(
      registerPluginCommand("other-plugin", {
        name: "pair",
        nativeNames: {
          telegram: "pair_device",
        },
        description: "Pair command",
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({
      ok: false,
      error: 'Command "pair_device" already registered by plugin "demo-plugin"',
    });
  });

  it("rejects reserved provider aliases", () => {
    expect(
      registerPluginCommand("demo-plugin", {
        name: "voice",
        nativeNames: {
          telegram: "help",
        },
        description: "Voice command",
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({
      ok: false,
      error:
        'Native command alias "telegram" invalid: Command name "help" is reserved by a built-in command',
    });
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

describe("executePluginCommand", () => {
  it("enforces owner requirements before running the handler", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));

    const result = await executePluginCommand({
      command: {
        name: "owneronly",
        description: "Owner-only command",
        requireOwner: true,
        handler,
        pluginId: "demo-plugin",
      },
      channel: "discord",
      senderId: "U123",
      isAuthorizedSender: true,
      senderIsOwner: false,
      commandBody: "/owneronly",
      config: {} as never,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "⚠️ This command requires owner authorization." });
  });

  it("blocks internal callers missing required gateway scopes", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));

    const result = await executePluginCommand({
      command: {
        name: "pairing",
        description: "Pairing command",
        requiredGatewayScopes: ["operator.pairing"],
        handler,
        pluginId: "demo-plugin",
      },
      surface: "webchat",
      channel: "webchat",
      senderId: "writer-1",
      isAuthorizedSender: true,
      gatewayClientScopes: ["operator.write"],
      commandBody: "/pairing",
      config: {} as never,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: "⚠️ This command requires operator.pairing for internal gateway callers.",
    });
  });

  it("allows admin-scoped internal callers to bypass narrower scope requirements", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));

    const result = await executePluginCommand({
      command: {
        name: "pairing",
        description: "Pairing command",
        requiredGatewayScopes: ["operator.pairing"],
        handler,
        pluginId: "demo-plugin",
      },
      surface: "webchat",
      channel: "webchat",
      senderId: "admin-1",
      isAuthorizedSender: true,
      gatewayClientScopes: ["operator.admin"],
      commandBody: "/pairing",
      config: {} as never,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: "ok" });
  });

  it("allows external callers to bypass gateway scope requirements", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));

    const result = await executePluginCommand({
      command: {
        name: "pairing",
        description: "Pairing command",
        requiredGatewayScopes: ["operator.pairing"],
        handler,
        pluginId: "demo-plugin",
      },
      surface: "telegram",
      channel: "telegram",
      senderId: "123",
      isAuthorizedSender: true,
      commandBody: "/pairing",
      config: {} as never,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: "ok" });
  });

  it("supports context-sensitive gateway scope requirements", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));
    const command: Parameters<typeof executePluginCommand>[0]["command"] = {
      name: "pair",
      description: "Pair command",
      resolveRequiredGatewayScopes: (ctx) => {
        const action = ctx.args?.trim().split(/\s+/, 1)[0]?.toLowerCase();
        return action === "approve" ? ["operator.pairing"] : undefined;
      },
      handler,
      pluginId: "demo-plugin",
    };

    const denied = await executePluginCommand({
      command,
      surface: "webchat",
      channel: "webchat",
      senderId: "writer-1",
      isAuthorizedSender: true,
      gatewayClientScopes: ["operator.write"],
      args: "approve latest",
      commandBody: "/pair approve latest",
      config: {} as never,
    });

    const allowed = await executePluginCommand({
      command,
      surface: "webchat",
      channel: "webchat",
      senderId: "writer-1",
      isAuthorizedSender: true,
      gatewayClientScopes: ["operator.write"],
      args: "qr",
      commandBody: "/pair qr",
      config: {} as never,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(denied).toEqual({
      text: "⚠️ This command requires operator.pairing for internal gateway callers.",
    });
    expect(allowed).toEqual({ text: "ok" });
  });

  it("returns a safe error reply when dynamic scope resolution throws", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));

    const result = await executePluginCommand({
      command: {
        name: "pair",
        description: "Pair command",
        resolveRequiredGatewayScopes: () => {
          throw new Error("resolver exploded");
        },
        handler,
        pluginId: "demo-plugin",
      },
      surface: "webchat",
      channel: "webchat",
      senderId: "writer-1",
      isAuthorizedSender: true,
      gatewayClientScopes: ["operator.write"],
      commandBody: "/pair",
      config: {} as never,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "⚠️ Command failed. Please try again later." });
  });
});
