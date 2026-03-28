import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function createVoiceCommand(overrides: Partial<Parameters<typeof registerPluginCommand>[1]> = {}) {
  return {
    name: "voice",
    description: "Voice command",
    handler: async () => ({ text: "ok" }),
    ...overrides,
  };
}

function resolveBindingConversationFromCommand(
  params: Parameters<typeof __testing.resolveBindingConversationFromCommand>[0],
) {
  return __testing.resolveBindingConversationFromCommand(params);
}

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it.each([
    {
      name: "rejects invalid command names",
      command: {
        // Runtime plugin payloads are untyped; guard at boundary.
        name: undefined as unknown as string,
        description: "Demo",
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: "Command name must be a string",
      },
    },
    {
      name: "rejects invalid command descriptions",
      command: {
        name: "demo",
        description: undefined as unknown as string,
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: "Command description must be a string",
      },
    },
  ] as const)("$name", ({ command, expected }) => {
    expect(registerPluginCommand("demo-plugin", command)).toEqual(expected);
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
    const result = registerPluginCommand(
      "demo-plugin",
      createVoiceCommand({
        nativeNames: {
          default: "talkvoice",
          discord: "discordvoice",
        },
        description: "Demo command",
      }),
    );

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
      first.registerPluginCommand(
        "demo-plugin",
        createVoiceCommand({
          nativeNames: {
            telegram: "voice",
          },
        }),
      ),
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
    const result = registerPluginCommand(
      "demo-plugin",
      createVoiceCommand({
        nativeNames: {
          default: "talkvoice",
          discord: "discordvoice",
        },
        description: "Demo command",
        acceptsArgs: true,
      }),
    );

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

  it.each([
    {
      name: "rejects provider aliases that collide with another registered command",
      setup: () =>
        registerPluginCommand(
          "demo-plugin",
          createVoiceCommand({
            nativeNames: {
              telegram: "pair_device",
            },
          }),
        ),
      candidate: {
        name: "pair",
        nativeNames: {
          telegram: "pair_device",
        },
        description: "Pair command",
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: 'Command "pair_device" already registered by plugin "demo-plugin"',
      },
    },
    {
      name: "rejects reserved provider aliases",
      candidate: createVoiceCommand({
        nativeNames: {
          telegram: "help",
        },
      }),
      expected: {
        ok: false,
        error:
          'Native command alias "telegram" invalid: Command name "help" is reserved by a built-in command',
      },
    },
  ] as const)("$name", ({ setup, candidate, expected }) => {
    setup?.();
    expect(registerPluginCommand("other-plugin", candidate)).toEqual(expected);
  });

  it.each([
    {
      name: "resolves Discord DM command bindings with the user target prefix intact",
      params: {
        channel: "discord",
        from: "discord:1177378744822943744",
        to: "slash:1177378744822943744",
        accountId: "default",
      },
      expected: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
    },
    {
      name: "resolves Discord guild command bindings with the channel target prefix intact",
      params: {
        channel: "discord",
        from: "discord:channel:1480554272859881494",
        accountId: "default",
      },
      expected: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1480554272859881494",
      },
    },
    {
      name: "resolves Discord thread command bindings with parent channel context intact",
      params: {
        channel: "discord",
        from: "discord:channel:1480554272859881494",
        accountId: "default",
        messageThreadId: "thread-42",
        threadParentId: "channel-parent-7",
      },
      expected: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1480554272859881494",
        parentConversationId: "channel-parent-7",
        threadId: "thread-42",
      },
    },
    {
      name: "resolves Telegram topic command bindings without a Telegram registry entry",
      params: {
        channel: "telegram",
        from: "telegram:group:-100123",
        to: "telegram:group:-100123:topic:77",
        accountId: "default",
      },
      expected: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100123",
        threadId: 77,
      },
    },
    {
      name: "resolves Telegram native slash command bindings using the From peer",
      params: {
        channel: "telegram",
        from: "telegram:group:-100123:topic:77",
        to: "slash:12345",
        accountId: "default",
        messageThreadId: 77,
      },
      expected: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100123",
        threadId: 77,
      },
    },
    {
      name: "falls back to the parsed From threadId for Telegram slash commands when messageThreadId is missing",
      params: {
        channel: "telegram",
        from: "telegram:group:-100123:topic:77",
        to: "slash:12345",
        accountId: "default",
      },
      expected: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100123",
        threadId: 77,
      },
    },
    {
      name: "does not resolve binding conversations for unsupported command channels",
      params: {
        channel: "slack",
        from: "slack:U123",
        to: "C456",
        accountId: "default",
      },
      expected: null,
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveBindingConversationFromCommand(params)).toEqual(expected);
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
