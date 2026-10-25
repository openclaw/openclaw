import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCommandDefinition } from "../../auto-reply/commands-registry.types.js";

const mockSkillCommands = [
  {
    skillName: "code-review",
    displayName: "Code Review",
    name: "code_review",
    description: "Run code review",
    modelVisible: true,
    acceptsArgs: true,
  },
];

function chatCommand(
  key: string,
  description: string,
  category: ChatCommandDefinition["category"],
  overrides: Partial<ChatCommandDefinition> = {},
): ChatCommandDefinition {
  return {
    key,
    nativeName: key,
    description,
    textAliases: [`/${key}`],
    scope: "both",
    category,
    ...overrides,
  };
}
type CommandArg = NonNullable<ChatCommandDefinition["args"]>[number];
const stringArg = (
  name: string,
  description: string,
  choices: CommandArg["choices"],
): CommandArg => ({ name, description, type: "string", choices });
const baseChatCommands: ChatCommandDefinition[] = [
  chatCommand("model", "Set model", "options", {
    textAliases: ["/model", "/m"],
    acceptsArgs: true,
    args: [
      stringArg("model", "Model identifier", [
        { value: "gpt-5.4", label: "GPT-5.4" },
        "sonnet-4.6",
      ]),
    ],
  }),
  chatCommand("help", "Show help", "session"),
  chatCommand("login", "Pair Codex login", "management", { nativeProviders: ["telegram"] }),
  chatCommand("commands", "List commands", "session", { nativeName: undefined, scope: "text" }),
  chatCommand("skill:code-review", "Run code review", "tools", {
    nativeName: "code_review",
    textAliases: ["/code_review"],
    acceptsArgs: true,
  }),
  chatCommand("debug_prompt", "Show raw prompt", "tools", {
    textAliases: ["/debug"],
    acceptsArgs: false,
    args: [stringArg("target", "Prompt target", () => [{ value: "last", label: "Last" }])],
    scope: "native",
  }),
];
let mockChatCommands = baseChatCommands;

const mockPluginSpecs = [{ name: "tts", description: "Text to speech", acceptsArgs: false }];
type RuntimeCommandRegistration = {
  pluginId: string;
  command: Omit<Parameters<typeof registerPluginCommandInRegistry>[2], "handler">;
};
vi.mock("../../auto-reply/commands-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/commands-registry.js")>()),
  listChatCommandsForConfig: vi.fn(() => mockChatCommands),
}));
vi.mock("../../skills/discovery/chat-commands.js", () => ({
  prepareSkillCommandsForAgents: vi.fn(async () => mockSkillCommands),
}));
vi.mock("../../plugins/command-specs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/command-specs.js")>()),
  getPluginCommandEntrySpecs: vi.fn((provider?: string) => {
    if (provider === "whatsapp") {
      return mockPluginSpecs;
    }
    return mockPluginSpecs.map((entry) => ({
      ...entry,
      nativeName: provider === "discord" ? "discord_tts" : entry.name,
    }));
  }),
}));
// mock-isolation: command inventory comes from this suite's synthetic plugin registry.
vi.mock("../../plugins/commands.js", () => ({
  listPluginCommands: vi.fn(() =>
    mockPluginSpecs.map((entry) => Object.assign({}, entry, { pluginId: "plugin-tts" })),
  ),
}));
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));
vi.mock("../../agents/agent-scope.js", () => ({
  AgentSelectionRequiredError: class AgentSelectionRequiredError extends Error {},
  listAgentIds: vi.fn(() => ["main", "dev"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  tryResolveLegacyCompatibilityAgentId: vi.fn(() => "main"),
}));
vi.mock("../../channels/plugins/read-only-command-defaults.js", () => ({
  resolveReadOnlyChannelCommandDefaults: () => undefined,
}));
// mock-isolation: resolve only synthetic channel plugins without loading bundled runtimes.
vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: vi.fn(channelPlugin),
  getChannelPlugin: vi.fn(channelPlugin),
}));

import {
  ErrorCodes,
  errorShape,
  type CommandEntry,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  COMMAND_ALIAS_MAX_ITEMS,
  COMMAND_ARG_CHOICES_MAX_ITEMS,
  COMMAND_ARGS_MAX_ITEMS,
  COMMAND_DESCRIPTION_MAX_LENGTH,
  COMMAND_LIST_MAX_ITEMS,
  COMMAND_NAME_MAX_LENGTH,
  CommandsListResultSchema,
} from "../../../packages/gateway-protocol/src/schema.js";
import { registerPluginCommandInRegistry } from "../../plugins/command-registration.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { commandsHandlers } from "./commands.js";

function channelPlugin(provider: string) {
  return provider !== "discord"
    ? undefined
    : {
        commands: {
          nativeCommandsAutoEnabled: true,
          resolveNativeCommandName: ({
            commandKey,
            defaultName,
          }: {
            commandKey: string;
            defaultName: string;
          }) => (commandKey === "model" ? "set_model" : defaultName),
        },
      };
}

async function callHandler(params: Record<string, unknown> = {}) {
  const respond = vi.fn<(ok: boolean, payload?: unknown, error?: unknown) => void>();
  await expectDefined(
    commandsHandlers["commands.list"],
    "commands.list handler",
  )({
    params,
    respond,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
    context: { getRuntimeConfig: () => ({}) } as never,
  });
  const [ok, payload, error] = expectDefined(respond.mock.calls[0], "commands.list response");
  return { ok, payload, error };
}

async function listCommands(params: Record<string, unknown> = {}): Promise<CommandEntry[]> {
  const { payload } = await callHandler(params);
  return (payload as { commands: CommandEntry[] }).commands;
}

function requireCommand<T extends { name: string }>(commands: T[], name: string): T {
  return expectDefined(
    commands.find((entry) => entry.name === name),
    `expected ${name} command`,
  );
}

function expectCommand(commands: CommandEntry[], name: string, expected?: object) {
  const command = commands.find((entry) => entry.name === name);
  if (expected) {
    expect(command).toMatchObject(expected);
  } else {
    expect(command).toBeUndefined();
  }
}

function createCommandRegistry(commands: RuntimeCommandRegistration[]) {
  const registry = createEmptyPluginRegistry();
  for (const { pluginId, command } of commands) {
    expect(
      registerPluginCommandInRegistry(registry, pluginId, { ...command, handler: () => ({}) }),
    ).toEqual({ ok: true });
  }
  return registry;
}

const setGatewayRegistry = (commands: RuntimeCommandRegistration[]) =>
  setActivePluginRegistry(createCommandRegistry(commands));

function registration(
  name: string,
  overrides: Partial<RuntimeCommandRegistration["command"]> = {},
): RuntimeCommandRegistration {
  return { pluginId: name.trim(), command: { name, description: "Demo command", ...overrides } };
}

describe("commands.list handler", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    vi.clearAllMocks();
    mockChatCommands = baseChatCommands.map((command) => Object.assign({}, command));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });

  it("projects legacy SDK categories into the current command catalog", async () => {
    const command = expectDefined(mockChatCommands[0], "model command fixture");
    command.category = "docks";
    const { ok, payload } = await callHandler();
    expect(ok).toBe(true);
    expect(Value.Check(CommandsListResultSchema, payload)).toBe(true);
    expect(requireCommand(await listCommands(), "model").category).toBe("tools");
  });

  it("serializes dynamic choices when acceptsArgs is true", async () => {
    const debugCmd = mockChatCommands.find((c) => c.key === "debug_prompt")!;
    debugCmd.acceptsArgs = true;
    const debug = requireCommand(await listCommands(), "debug_prompt");
    const arg = expectDefined(debug.args?.[0], "dynamic argument");
    expect(arg.dynamic).toBe(true);
    expect(arg.choices).toBeUndefined();
  });

  it("limits provider-specific native commands while keeping login text-visible", async () => {
    expectCommand(await listCommands({ provider: "discord" }), "login");
    expectCommand(await listCommands({ provider: "slack", scope: "native" }), "login");
    expectCommand(await listCommands({ provider: "telegram" }), "login", { nativeName: "login" });
    expectCommand(await listCommands({ provider: "discord", scope: "text" }), "login", {
      name: "login",
      textAliases: ["/login"],
    });
  });

  it.each(["text", "native"] as const)(
    "projects registered plugin commands without native support for scope=%s",
    async (scope) => {
      setGatewayRegistry([registration("demo")]);
      const commands = await listCommands({ provider: "whatsapp", scope });
      expect(commands.filter((command) => command.source === "plugin")).toEqual(
        scope === "text"
          ? [
              {
                name: "demo",
                textAliases: ["/demo"],
                description: "Demo command",
                source: "plugin",
                scope: "both",
                acceptsArgs: false,
              },
            ]
          : [],
      );
    },
  );

  it.each([
    ["native", "model", "set_model", ["/model", "/m"]],
    ["plugin", "tts", "discord_tts", ["/tts"]],
  ] as const)(
    "keeps %s text names and provider-native aliases",
    async (source, name, nativeName, textAliases) => {
      const commands = await listCommands({ provider: "discord", scope: "text" });
      expect(commands.find((c) => c.source === source && c.name === name)).toMatchObject({
        name,
        nativeName,
        textAliases,
      });
      expect(commands.find((c) => c.name === nativeName)).toBeUndefined();
    },
  );

  it("projects gateway registry commands with channel filters and native aliases", async () => {
    setGatewayRegistry([
      registration("android_only", { channels: ["android"] }),
      registration("  demo  ", {
        description: "  Demo command  ",
        acceptsArgs: true,
        nativeNames: { discord: "discord_demo" },
        channels: ["discord"],
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
        },
      }),
    ]);

    const commands = await listCommands({ provider: "discord" });
    expect(commands.find((c) => c.source === "plugin")).toMatchObject({
      name: "discord_demo",
      nativeName: "discord_demo",
      description: "Demo command",
      textAliases: ["/demo"],
      acceptsArgs: true,
      clientPresentation: { when: "no-arguments", action: { kind: "device-pairing" } },
    });
    expect(commands.find((c) => c.source === "plugin" && c.name === "tts")).toBeUndefined();
    expect(commands.find((c) => c.name === "android_only")).toBeUndefined();
  });

  it.each([false, true])(
    "lists only the request registry's plugin commands (empty=%s)",
    async (empty) => {
      setGatewayRegistry([registration("ambient")]);
      const scoped = createCommandRegistry(empty ? [] : [registration("scoped")]);
      const commands = await withPluginRuntimeRegistryScope(scoped, () =>
        listCommands({ scope: "text" }),
      );
      expect(
        commands.filter((command) => command.source === "plugin").map((command) => command.name),
      ).toEqual(empty ? [] : ["scoped"]);
      expect((await listCommands({ scope: "text" })).find((c) => c.source === "plugin")?.name).toBe(
        "ambient",
      );
    },
  );

  it("excludes args when includeArgs=false", async () => {
    const model = requireCommand(await listCommands({ includeArgs: false }), "model");
    expect(model.args).toBeUndefined();
  });

  it("caps serialized command payload size and field lengths", async () => {
    const longToken = "x".repeat(COMMAND_NAME_MAX_LENGTH + 50);
    const aliasBase = "alias".repeat(20);
    const descriptionPrefix = "d".repeat(COMMAND_DESCRIPTION_MAX_LENGTH - 1);
    const longDescription = `${descriptionPrefix}😀tail`;
    const oversizedArgs = Array.from({ length: COMMAND_ARGS_MAX_ITEMS + 5 }, (_, argIndex) =>
      stringArg(
        `${longToken}-${argIndex}`,
        longDescription,
        Array.from({ length: COMMAND_ARG_CHOICES_MAX_ITEMS + 5 }, (_Local, choiceIndex) => ({
          value: `${longToken}-${choiceIndex}`,
          label: `${longToken}-${choiceIndex}`,
        })),
      ),
    );
    mockChatCommands = Array.from({ length: COMMAND_LIST_MAX_ITEMS + 25 }, (_, index) =>
      chatCommand(`cmd-${index}`, "short", "tools", { nativeName: undefined }),
    );
    mockChatCommands[0] = chatCommand(longToken, longDescription, "tools", {
      nativeName: undefined,
      textAliases: Array.from(
        { length: COMMAND_ALIAS_MAX_ITEMS + 5 },
        (_, aliasIndex) => `/${aliasBase}-0-${aliasIndex}`,
      ),
      acceptsArgs: true,
      args: oversizedArgs,
    });

    const commands = await listCommands();
    expect(commands).toHaveLength(COMMAND_LIST_MAX_ITEMS);
    const first = expectDefined(commands[0], "commands[0] test invariant");
    expect(first.name.length).toBeLessThanOrEqual(COMMAND_NAME_MAX_LENGTH);
    expect(first.description).toBe(descriptionPrefix);
    expect(expectDefined(first.textAliases, "aliases").length).toBeLessThanOrEqual(
      COMMAND_ALIAS_MAX_ITEMS,
    );
    expect(first.args).toHaveLength(COMMAND_ARGS_MAX_ITEMS);
    const firstArg = expectDefined(first.args?.[0], "first argument");
    expect(firstArg.choices).toHaveLength(COMMAND_ARG_CHOICES_MAX_ITEMS);
  });

  it.each([
    [
      { agentId: "nonexistent" },
      errorShape(ErrorCodes.INVALID_REQUEST, 'unknown agent id "nonexistent"'),
    ],
    [{ scope: "invalid" }, expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST })],
  ] as const)("rejects invalid command-list requests: %j", async (params, expected) => {
    const { ok, error } = await callHandler(params);
    expect(ok).toBe(false);
    expect(error).toEqual(expected);
  });
});
