/** Tests command registry definitions, native specs, aliases, and argument menus. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createCommandTurnContext } from "./command-turn-context.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  isActiveRunSafeCommandTurn,
  listChatCommands,
  listChatCommandsForConfig,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  mergeNativeCommandSpecs,
  normalizeCommandBody,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  resolveTextCommand,
  shouldHandleTextCommands,
} from "./commands-registry.js";
import type {
  ChatCommandDefinition,
  CommandArgValues,
  CommandArgChoiceContext,
  NativeCommandSpec,
} from "./commands-registry.types.js";

type NativeNameParams = { commandKey: string; defaultName: string };
const ollamaModel = { id: "glm-5.2:cloud", name: "GLM 5.2 Cloud", reasoning: true };
function modelConfig<T>(provider: string, model: T) {
  return { models: { providers: { [provider]: { models: [model] } } } };
}
function agentModels<T>(models: T, model?: string) {
  return { agents: { defaults: { models, ...(model ? { model } : {}) } } };
}
function createNativeCommandsRegistry(
  id: "discord" | "slack",
  rename?: { key: string; name: string },
) {
  const plugin = createChannelTestPluginBase({
    id,
    capabilities: { nativeCommands: true, chatTypes: ["direct"] },
  });
  const commands = rename
    ? {
        resolveNativeCommandName: ({ commandKey, defaultName }: NativeNameParams) =>
          commandKey === rename.key ? rename.name : defaultName,
      }
    : undefined;
  return createTestRegistry([
    { pluginId: id, source: "test", plugin: { ...plugin, ...(commands ? { commands } : {}) } },
  ]);
}

function installNativeOverride(id: "discord" | "slack", key: string, name: string) {
  setActivePluginRegistry(createNativeCommandsRegistry(id, { key, name }));
}

function installOllamaThinkingProvider() {
  const registry = createTestRegistry();
  registry.providers.push({
    pluginId: "ollama",
    source: "test",
    provider: {
      id: "ollama",
      label: "Ollama",
      auth: [],
      resolveThinkingProfile: ({ reasoning }: { reasoning?: boolean }) => ({
        levels:
          reasoning === true
            ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
            : [{ id: "off" }],
        defaultLevel: "off",
      }),
    } as never,
  });
  setActivePluginRegistry(registry);
}

beforeEach(() => {
  vi.doUnmock("../channels/plugins/index.js");
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
});

function commandKeySet(commands: readonly ChatCommandDefinition[]): Set<string> {
  return new Set(commands.map((command) => command.key));
}

function nativeNameSet(specs: readonly { name: string }[]): Set<string> {
  return new Set(specs.map((spec) => spec.name));
}

function expectSetMembers(
  values: ReadonlySet<string>,
  expected: readonly string[],
  present: boolean,
) {
  for (const value of expected) {
    expect(values.has(value), value).toBe(present);
  }
}

function chatCommand(key: string): ChatCommandDefinition {
  return expectDefined(
    listChatCommands().find((candidate) => candidate.key === key),
    `command ${key}`,
  );
}

function nativeCommand(name: string, provider?: string): ChatCommandDefinition {
  return expectDefined(findCommandByNativeName(name, provider), `native command ${name}`);
}
const loadedCommand = (name: string, provider: string) =>
  findCommandByNativeName(name, provider, { includeBundledChannelFallback: false });

type MenuParams = Parameters<typeof resolveCommandArgMenu>[0];
function argMenu(params: Omit<MenuParams, "cfg"> & { cfg?: MenuParams["cfg"] }) {
  return expectDefined(
    resolveCommandArgMenu({ cfg: {}, ...params }),
    `arg menu for ${params.command.key}`,
  );
}
const menuValues = (menu: ReturnType<typeof argMenu>) => menu.choices.map((choice) => choice.value);

function commandFixture(
  key: string,
  args: ChatCommandDefinition["args"],
  options: Partial<ChatCommandDefinition> = {},
): ChatCommandDefinition {
  return {
    key,
    description: key,
    textAliases: [],
    scope: "both",
    argsParsing: "positional",
    args,
    ...options,
  };
}

function expectLength(value: string, max: number) {
  expect(value.length).toBeGreaterThan(0);
  expect(value.length).toBeLessThanOrEqual(max);
}
function commandArg(
  name: string,
  fields: Partial<NonNullable<ChatCommandDefinition["args"]>[number]> = {},
) {
  return { name, description: name, type: "string" as const, ...fields };
}
const restrictedConfig = (enabled: boolean, native?: boolean) => ({
  commands: {
    config: enabled,
    plugins: enabled,
    debug: enabled,
    ...(native === undefined ? {} : { native }),
  },
});

describe("commands registry", () => {
  it("registers /login natively for Discord, Slack, and Telegram", () => {
    expect(nativeNameSet(listNativeCommandSpecs()).has("login")).toBe(false);
    for (const provider of ["discord", "slack"] as const) {
      setActivePluginRegistry(createNativeCommandsRegistry(provider));
      expect(nativeNameSet(listNativeCommandSpecs({ provider })).has("login")).toBe(true);
      expect(loadedCommand("login", provider)?.key).toBe("login");
    }
    expect(loadedCommand("login", "telegram")?.key).toBe("login");
    expect(loadedCommand("login", "signal")).toBeUndefined();
  });

  it.each(["native", "text"] as const)(
    "allows only authorized login cancellation beside an active run (%s)",
    (source) => {
      setActivePluginRegistry(createNativeCommandsRegistry("discord"));
      for (const [body, expected] of [
        ["/login cancel", true],
        [" /login CANCEL ", true],
        ["/login", false],
        ["/login openrouter", false],
        ["/login cancel openrouter", false],
      ] as const) {
        for (const authorized of [true, false]) {
          const commandTurn = createCommandTurnContext(source, {
            authorized,
            commandName: "login",
            body,
          });
          expect(isActiveRunSafeCommandTurn({ commandTurn, cfg: {}, provider: "discord" })).toBe(
            authorized && expected,
          );
        }
      }
    },
  );

  it("filters commands based on config flags", () => {
    const disabled = listChatCommandsForConfig(restrictedConfig(false));
    expectSetMembers(commandKeySet(disabled), ["config", "plugins", "debug"], false);
    const enabled = listChatCommandsForConfig(restrictedConfig(true));
    expectSetMembers(commandKeySet(enabled), ["config", "plugins", "debug"], true);
    const nativeDisabled = listNativeCommandSpecsForConfig(restrictedConfig(false, true));
    expectSetMembers(nativeNameSet(nativeDisabled), ["config", "plugins", "debug"], false);
  });

  it("does not enable restricted commands from inherited flags", () => {
    const inheritedCommands = Object.create({
      config: true,
      plugins: true,
      debug: true,
      bash: true,
    }) as Record<string, unknown>;
    const commands = listChatCommandsForConfig({ commands: inheritedCommands as never });
    expectSetMembers(commandKeySet(commands), ["config", "plugins", "debug", "bash"], false);
  });

  it("appends skill commands when provided", () => {
    const skillCommands = [
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
        descriptionLocalizations: { ko: "데모 스킬" },
      },
    ];
    const commands = listChatCommandsForConfig(restrictedConfig(false), { skillCommands });
    const command = commands.find((spec) => spec.nativeName === "demo_skill");
    expect(command?.category).toBe("tools");
    const native = listNativeCommandSpecsForConfig(restrictedConfig(false, true), {
      skillCommands,
    });
    expect(native.find((spec) => spec.name === "demo_skill")?.descriptionLocalizations).toEqual({
      ko: "데모 스킬",
    });
  });

  it("merges native command specs with primary precedence and stable secondary order", () => {
    const spec = (name: string): NativeCommandSpec => ({
      name,
      description: name,
      acceptsArgs: false,
    });
    const primary = [" Primary ", "", "PRIMARY"].map(spec);
    const acceptedSecondary: NativeCommandSpec = {
      name: "Secondary",
      description: "secondary",
      descriptionLocalizations: { de: "Sekundär" },
      acceptsArgs: true,
      args: [commandArg("value")],
      isAlias: true,
    };
    const secondary: readonly NativeCommandSpec[] = [
      ...["primary", " "].map(spec),
      acceptedSecondary,
      ...[" secondary ", "third"].map(spec),
    ];
    const primaryBefore = structuredClone(primary);
    const secondaryBefore = structuredClone(secondary);
    const collisions: string[] = [];
    const merged = mergeNativeCommandSpecs({
      primary,
      secondary,
      onCollision: (name) => collisions.push(name),
    });
    expect(merged).toEqual([primary[0], acceptedSecondary, secondary[4]]);
    expect(merged).not.toBe(primary);
    expect(merged[0]).toBe(primary[0]);
    expect(merged[1]).toBe(acceptedSecondary);
    expect(merged[2]).toBe(secondary[4]);
    expect(collisions).toEqual(["primary", "secondary"]);
    expect(primary).toEqual(primaryBefore);
    expect(secondary).toEqual(secondaryBefore);
  });

  it("applies slack native command overrides", () => {
    installNativeOverride("slack", "status", "agentstatus");
    const native = listNativeCommandSpecsForConfig(
      { commands: { native: true } },
      { provider: "slack" },
    );
    expect([...nativeNameSet(native)]).toContain("agentstatus");
    expect(nativeCommand("agentstatus", "slack").key).toBe("status");
    expect(findCommandByNativeName("status", "slack")).toBeUndefined();
    expect(loadedCommand("agentstatus", "slack")?.key).toBe("status");
    expect(loadedCommand("status", "slack")).toBeUndefined();
  });

  it("keeps discord native command specs within slash-command limits", () => {
    installNativeOverride("discord", "tts", "voice");
    const cfg = { commands: { native: true } };
    const native = listNativeCommandSpecsForConfig(cfg, { provider: "discord" });
    for (const spec of native) {
      expect(spec.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expectLength(spec.description, 100);
      expect(spec.args?.length ?? 0).toBeLessThanOrEqual(25);
      const command = nativeCommand(spec.name, "discord");
      const args = command.args ?? spec.args ?? [];
      expect(new Set(args.map((arg) => arg.name)).size).toBe(args.length);
      const required = args.map((arg) => arg.required ?? false);
      expect(required).toEqual(required.toSorted((a, b) => Number(b) - Number(a)));
      for (const arg of args) {
        expect(arg.name).toMatch(/^[a-z0-9_-]{1,32}$/);
        expectLength(arg.description, 100);
        const choices = resolveCommandArgChoices({ command, arg, cfg, provider: "discord" });
        expect(choices.length).toBeLessThanOrEqual(25);
        for (const choice of choices) {
          expectLength(choice.label, 100);
          expectLength(choice.value, 100);
        }
      }
    }
  });

  it("registers fast mode as a first-class options command", () => {
    const fast = chatCommand("fast");
    expect(fast).toMatchObject({ nativeName: "fast", textAliases: ["/fast"], category: "options" });
    const modelRef = "openai-codex/gpt-5.5";
    const menu = argMenu({
      command: fast,
      cfg: agentModels(
        { [modelRef]: { params: { fastMode: "auto", fastAutoOnSeconds: 30 } } },
        modelRef,
      ) as never,
      provider: "openai-codex",
      model: "gpt-5.5",
    });
    expect(menu.choices).toEqual([
      { label: "on", value: "on" },
      { label: "off", value: "off" },
      { label: "auto (30 sec)", value: "auto" },
      { label: "default", value: "default" },
      { label: "status", value: "status" },
    ]);
  });

  it.each([
    ["/help", "help"],
    ["/help:", "help"],
    ["/help list", null],
    ["/help: list", null],
    ["/think high", "think"],
    ["/thinking: high", "think"],
    ["try /status", null],
  ] as const)("resolves text command %s", (text, key) => {
    const resolved = resolveTextCommand(text);
    expect(resolved && resolved.command.key).toBe(key);
  });

  it("respects text command gating", () => {
    setActivePluginRegistry(createNativeCommandsRegistry("discord"));
    const cfg = { commands: { text: false } };
    const handles = (surface: string, commandSource: "text" | "native" = "text") =>
      shouldHandleTextCommands({ cfg, surface, commandSource });
    expect(handles("discord")).toBe(false);
    expect(handles("whatsapp")).toBe(true);
    expect(handles("discord", "native")).toBe(true);
    setActivePluginRegistry(createNativeCommandsRegistry("slack"));
    for (const [surface, expected] of [
      ["discord", true],
      [" SLACK ", false],
    ] as const) {
      expect(handles(surface)).toBe(expected);
    }
  });

  it.each([
    ["unresolved_bot", { targetedCommandMode: "pre-identity" }, "/help"],
    ["unresolved_bot", undefined, "/help@unresolved_bot"],
    [
      "some_other_bot",
      { botUsername: "openclaw_bot", targetedCommandMode: "pre-identity" },
      "/help@some_other_bot",
    ],
  ] as const)("normalizes commands targeting %s only when requested", (bot, options, expected) => {
    expect(normalizeCommandBody(`/help@${bot}`, options)).toBe(expected);
  });
});

describe("commands registry args", () => {
  it("parses positional args and captureRemaining", () => {
    const command = commandFixture("debug", [
      commandArg("action"),
      commandArg("path"),
      commandArg("value", { captureRemaining: true }),
    ]);
    const args = expectDefined(parseCommandArgs(command, "set foo bar baz"), "parsed args");
    expect(args.values).toEqual({ action: "set", path: "foo", value: "bar baz" });
  });
  it("serializes args via raw first, then values", () => {
    const command = commandFixture("model", [commandArg("model", { captureRemaining: true })]);
    expect(buildCommandTextFromArgs(command)).toBe("/model");
    expect(buildCommandTextFromArgs(command, { raw: "gpt-5.4" })).toBe("/model gpt-5.4");
    expect(buildCommandTextFromArgs(command, { values: { model: "gpt-5.4" } })).toBe(
      "/model gpt-5.4",
    );
  });
  const structuredArgCases: Array<[string, CommandArgValues, string]> = [
    [
      "config",
      { action: " GET ", path: " agents.defaults.model " },
      "/config get agents.defaults.model",
    ],
    ["mcp", { action: "get", path: "servers.github" }, "/mcp get servers.github"],
    ["plugins", { action: "get", path: "discord" }, "/plugins get discord"],
    ["plugins", { action: "list", path: "ignored" }, "/plugins list"],
    ["debug", { action: "show", path: "ignored" }, "/debug show"],
  ];
  it.each(structuredArgCases)("serializes structured %s args", (key, values, expected) => {
    expect(buildCommandTextFromArgs(chatCommand(key), { values })).toBe(expected);
  });
  it("resolves function-based choices with a default provider/model context", () => {
    const choices = vi.fn<(context: CommandArgChoiceContext) => string[]>(() => ["low", "high"]);
    const command = commandFixture("think", [commandArg("level", { choices })], {
      argsMenu: "auto",
    });
    const menu = argMenu({
      command,
      agentRuntime: "codex",
    });
    expect(menu.arg.name).toBe("level");
    expect(menu.choices).toEqual([
      { label: "low", value: "low" },
      { label: "high", value: "high" },
    ]);
    expect(formatCommandArgMenuTitle({ command, menu })).toBe(
      "Choose level for /think.\nOptions: low, high.",
    );
    const seenChoice = expectDefined(choices.mock.lastCall?.[0], "command choice context");
    expect(seenChoice).toMatchObject({
      command: { key: "think" },
      arg: { name: "level" },
      agentRuntime: "codex",
    });
    // The default model's bundled row supplies its thinking facts.
    expect(seenChoice.catalog).toEqual([
      expect.objectContaining({ provider: seenChoice.provider, id: seenChoice.model }),
    ]);
    expect(typeof seenChoice.provider).toBe("string");
    expect(seenChoice.provider?.trim().length).toBeGreaterThan(0);
    expect(typeof seenChoice.model).toBe("string");
    expect(seenChoice.model?.trim().length).toBeGreaterThan(0);
  });
  it.each([
    ["gpt-5.6-sol", "codex"],
    ["gpt-5.6-terra", "codex"],
    ["gpt-5.6-luna", "codex"],
    ["gpt-5.6-luna", "openclaw"],
  ])("uses the %s thinking profile with %s native menus", (model, agentRuntime) => {
    const command = nativeCommand("think");
    const menu = argMenu({
      command,
      provider: "openai",
      model,
      agentRuntime,
    });
    expect(menu.choices.some((choice) => choice.value === "ultra")).toBe(true);
  });
  it("builds the /think menu for the configured default model's bundled row", () => {
    const command = nativeCommand("think");
    const menu = argMenu({
      command,
      cfg: { agents: { defaults: { model: { primary: "moonshot/kimi-k3" } } } },
    });
    expect(menuValues(menu)).toContain("max");
    expect(menuValues(menu)).not.toContain("low");
  });
  it.each<[unknown, CommandArgChoiceContext["catalog"]]>([
    [modelConfig("ollama", ollamaModel), undefined],
    [agentModels({ "ollama/*": {} }), [{ provider: "ollama", ...ollamaModel }]],
  ])("uses model catalog %j reasoning for /think arg menus", (cfg, catalog) => {
    installOllamaThinkingProvider();
    const command = nativeCommand("think");
    const menu = argMenu({
      command,
      cfg: cfg as never,
      provider: "ollama",
      model: "glm-5.2:cloud",
      catalog,
    });
    expect(menu.arg.name).toBe("level");
    expect(menuValues(menu)).toEqual(["default", "off", "low", "medium", "high", "max"]);
    expect(formatCommandArgMenuTitle({ command, menu })).toBe(
      "Choose level for /think.\nOptions: default, off, low, medium, high, max.",
    );
  });
  it("uses configured model compat for /think arg menus", () => {
    const command = nativeCommand("think");
    const menu = argMenu({
      command,
      cfg: modelConfig("gmn", {
        id: "gpt-5.4",
        name: "GPT 5.4 via GMN",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      }) as never,
      provider: "gmn",
      model: "gpt-5.4",
    });
    expect(menuValues(menu)).toContain("xhigh");
    expect(formatCommandArgMenuTitle({ command, menu })).toContain("xhigh");
  });
  it("does not show menus when args were provided as raw text only", () => {
    const command = commandFixture(
      "usage",
      [
        commandArg("mode", {
          description: "on or off",
          choices: ["off", "tokens", "full", "cost"],
        }),
      ],
      { argsMenu: "auto", argsParsing: "none" },
    );
    const menu = resolveCommandArgMenu({ command, args: { raw: "on" }, cfg: {} as never });
    expect(menu).toBeNull();
  });
});
