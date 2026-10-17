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
  serializeCommandArgs,
  shouldHandleTextCommands,
} from "./commands-registry.js";
import type {
  ChatCommandDefinition,
  CommandArgValues,
  CommandArgChoiceContext,
  NativeCommandSpec,
} from "./commands-registry.types.js";

type NativeNameParams = { commandKey: string; defaultName: string };
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

function expectSetContainsAll(values: ReadonlySet<string>, expected: readonly string[]) {
  for (const value of expected) {
    expect(values.has(value), `expected set to contain ${value}`).toBe(true);
  }
}

function expectSetOmitsAll(values: ReadonlySet<string>, expected: readonly string[]) {
  for (const value of expected) {
    expect(values.has(value), `expected set not to contain ${value}`).toBe(false);
  }
}

function requireChatCommand(key: string): ChatCommandDefinition {
  return expectDefined(
    listChatCommands().find((candidate) => candidate.key === key),
    `command ${key}`,
  );
}

function requireNativeCommand(name: string, provider?: string): ChatCommandDefinition {
  return expectDefined(findCommandByNativeName(name, provider), `native command ${name}`);
}

function requireNativeSpec(specs: readonly NativeCommandSpec[], name: string) {
  return expectDefined(
    specs.find((candidate) => candidate.name === name),
    `native spec ${name}`,
  );
}

function requireCommandArg(
  command: ChatCommandDefinition,
  name: string,
): NonNullable<ChatCommandDefinition["args"]>[number] {
  return expectDefined(
    command.args?.find((candidate) => candidate.name === name),
    `arg ${name}`,
  );
}

function requireCommandArgMenu(
  params: Omit<Parameters<typeof resolveCommandArgMenu>[0], "cfg"> & {
    cfg?: Parameters<typeof resolveCommandArgMenu>[0]["cfg"];
  },
): NonNullable<ReturnType<typeof resolveCommandArgMenu>> {
  return expectDefined(
    resolveCommandArgMenu({ cfg: {}, ...params }),
    `arg menu for ${params.command.key}`,
  );
}

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

describe("commands registry", () => {
  it("registers /login natively for Discord, Slack, and Telegram", () => {
    const command = requireChatCommand("login");
    expect(command).toMatchObject({
      textAliases: ["/login"],
      nativeName: "login",
      nativeProviders: ["discord", "slack", "telegram"],
    });
    expect(nativeNameSet(listNativeCommandSpecs()).has("login")).toBe(false);
    for (const provider of ["discord", "slack"] as const) {
      setActivePluginRegistry(createNativeCommandsRegistry(provider));
      expect(nativeNameSet(listNativeCommandSpecs({ provider })).has("login")).toBe(true);
      expect(
        findCommandByNativeName("login", provider, { includeBundledChannelFallback: false })?.key,
      ).toBe("login");
    }
    expect(
      findCommandByNativeName("login", "telegram", { includeBundledChannelFallback: false })?.key,
    ).toBe("login");
    expect(
      findCommandByNativeName("login", "signal", { includeBundledChannelFallback: false }),
    ).toBeUndefined();
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
          expect(
            isActiveRunSafeCommandTurn({
              commandTurn: createCommandTurnContext(source, {
                authorized,
                commandName: "login",
                body,
              }),
              cfg: {},
              provider: "discord",
            }),
          ).toBe(authorized && expected);
        }
      }
    },
  );

  it("filters commands based on config flags", () => {
    const disabled = listChatCommandsForConfig({
      commands: { config: false, plugins: false, debug: false },
    });
    expectSetOmitsAll(commandKeySet(disabled), ["config", "plugins", "debug"]);
    const enabled = listChatCommandsForConfig({
      commands: { config: true, plugins: true, debug: true },
    });
    expectSetContainsAll(commandKeySet(enabled), ["config", "plugins", "debug"]);
    const nativeDisabled = listNativeCommandSpecsForConfig({
      commands: { config: false, plugins: false, debug: false, native: true },
    });
    expectSetOmitsAll(nativeNameSet(nativeDisabled), ["config", "plugins", "debug"]);
  });

  it("does not enable restricted commands from inherited flags", () => {
    const inheritedCommands = Object.create({
      config: true,
      plugins: true,
      debug: true,
      bash: true,
    }) as Record<string, unknown>;
    const commands = listChatCommandsForConfig({ commands: inheritedCommands as never });
    expectSetOmitsAll(commandKeySet(commands), ["config", "plugins", "debug", "bash"]);
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
    const commands = listChatCommandsForConfig(
      { commands: { config: false, plugins: false, debug: false } },
      { skillCommands },
    );
    const command = commands.find((spec) => spec.nativeName === "demo_skill");
    expect(command?.category).toBe("tools");
    const native = listNativeCommandSpecsForConfig(
      { commands: { config: false, plugins: false, debug: false, native: true } },
      { skillCommands },
    );
    expect(requireNativeSpec(native, "demo_skill").descriptionLocalizations).toEqual({
      ko: "데모 스킬",
    });
  });

  it("merges native command specs with primary precedence and stable secondary order", () => {
    const primary: readonly NativeCommandSpec[] = [
      { name: " Primary ", description: "primary", acceptsArgs: false },
      { name: "", description: "blank primary", acceptsArgs: false },
      { name: "PRIMARY", description: "duplicate primary", acceptsArgs: false },
    ];
    const acceptedSecondary: NativeCommandSpec = {
      name: "Secondary",
      description: "secondary",
      descriptionLocalizations: { de: "Sekundär" },
      acceptsArgs: true,
      args: [{ name: "value", description: "value", type: "string" }],
      isAlias: true,
    };
    const secondary: readonly NativeCommandSpec[] = [
      { name: "primary", description: "primary collision", acceptsArgs: false },
      { name: " ", description: "blank secondary", acceptsArgs: false },
      acceptedSecondary,
      { name: " secondary ", description: "secondary collision", acceptsArgs: false },
      { name: "third", description: "third", acceptsArgs: false },
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
    expect(requireNativeCommand("agentstatus", "slack").key).toBe("status");
    expect(findCommandByNativeName("status", "slack")).toBeUndefined();
    expect(
      findCommandByNativeName("agentstatus", "slack", { includeBundledChannelFallback: false })
        ?.key,
    ).toBe("status");
    expect(
      findCommandByNativeName("status", "slack", { includeBundledChannelFallback: false }),
    ).toBeUndefined();
  });

  it("keeps discord native command specs within slash-command limits", () => {
    installNativeOverride("discord", "tts", "voice");
    const cfg = { commands: { native: true } };
    const native = listNativeCommandSpecsForConfig(cfg, { provider: "discord" });
    for (const spec of native) {
      expect(spec.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expectLength(spec.description, 100);
      expect(spec.args?.length ?? 0).toBeLessThanOrEqual(25);
      const command = requireNativeCommand(spec.name, "discord");
      const args = command.args ?? spec.args ?? [];
      const argNames = new Set<string>();
      let sawOptional = false;
      for (const arg of args) {
        expect(argNames.has(arg.name)).toBe(false);
        argNames.add(arg.name);
        const isRequired = arg.required ?? false;
        if (!isRequired) {
          sawOptional = true;
        } else {
          expect(sawOptional).toBe(false);
        }
        expect(arg.name).toMatch(/^[a-z0-9_-]{1,32}$/);
        expectLength(arg.description, 100);
        const choices = resolveCommandArgChoices({ command, arg, cfg, provider: "discord" });
        if (choices.length === 0) {
          continue;
        }
        expect(choices.length).toBeLessThanOrEqual(25);
        for (const choice of choices) {
          expectLength(choice.label, 100);
          expectLength(choice.value, 100);
        }
      }
    }
  });

  it("registers fast mode as a first-class options command", () => {
    const fast = requireChatCommand("fast");
    expect(fast).toMatchObject({ nativeName: "fast", textAliases: ["/fast"], category: "options" });
    const modeArg = requireCommandArg(fast, "mode");
    expect(modeArg.description).toContain("ultrafast");
    expect(typeof modeArg.choices).toBe("function");
    const menu = requireCommandArgMenu({
      command: fast,
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            models: {
              "openai-codex/gpt-5.5": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
            },
          },
        },
      } as never,
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

  it("detects known text commands", () => {
    for (const command of listChatCommands()) {
      for (const alias of command.textAliases) {
        expect(resolveTextCommand(alias)?.command.key).toBe(command.key);
        expect(resolveTextCommand(`${alias}:`)?.command.key).toBe(command.key);

        if (command.acceptsArgs) {
          expect(resolveTextCommand(`${alias} list`)?.command.key).toBe(command.key);
          expect(resolveTextCommand(`${alias}: list`)?.command.key).toBe(command.key);
        } else {
          expect(resolveTextCommand(`${alias} list`)).toBeNull();
          expect(resolveTextCommand(`${alias}: list`)).toBeNull();
        }
      }
    }
    expect(resolveTextCommand("try /status")).toBeNull();
  });

  it("respects text command gating", () => {
    setActivePluginRegistry(createNativeCommandsRegistry("discord"));
    const cfg = { commands: { text: false } };
    expect(shouldHandleTextCommands({ cfg, surface: "discord", commandSource: "text" })).toBe(
      false,
    );
    expect(shouldHandleTextCommands({ cfg, surface: "whatsapp", commandSource: "text" })).toBe(
      true,
    );
    expect(shouldHandleTextCommands({ cfg, surface: "discord", commandSource: "native" })).toBe(
      true,
    );
    setActivePluginRegistry(createNativeCommandsRegistry("slack"));
    for (const [surface, expected] of [
      ["discord", true],
      [" SLACK ", false],
    ] as const) {
      expect(shouldHandleTextCommands({ cfg, surface, commandSource: "text" })).toBe(expected);
    }
  });

  it("normalizes targeted command bodies before bot identity only when requested", () => {
    expect(
      normalizeCommandBody("/help@unresolved_bot", { targetedCommandMode: "pre-identity" }),
    ).toBe("/help");
    expect(normalizeCommandBody("/help@unresolved_bot")).toBe("/help@unresolved_bot");
    expect(
      normalizeCommandBody("/help@some_other_bot", {
        botUsername: "openclaw_bot",
        targetedCommandMode: "pre-identity",
      }),
    ).toBe("/help@some_other_bot");
  });
});

describe("commands registry args", () => {
  function createUsageModeCommand(
    argsParsing: ChatCommandDefinition["argsParsing"] = "positional",
    description = "mode",
  ): ChatCommandDefinition {
    return commandFixture(
      "usage",
      [{ name: "mode", description, type: "string", choices: ["off", "tokens", "full", "cost"] }],
      { argsMenu: "auto", argsParsing },
    );
  }
  it("parses positional args and captureRemaining", () => {
    const command = commandFixture("debug", [
      { name: "action", description: "action", type: "string" },
      { name: "path", description: "path", type: "string" },
      { name: "value", description: "value", type: "string", captureRemaining: true },
    ]);
    const args = parseCommandArgs(command, "set foo bar baz");
    if (!args) {
      throw new Error("Expected parsed command args");
    }
    expect(args.values).toEqual({ action: "set", path: "foo", value: "bar baz" });
  });
  it("serializes args via raw first, then values", () => {
    const command = commandFixture("model", [
      { name: "model", description: "model", type: "string", captureRemaining: true },
    ]);
    expect(serializeCommandArgs(command, { raw: "gpt-5.4" })).toBe("gpt-5.4");
    expect(buildCommandTextFromArgs(command)).toBe("/model");
    expect(buildCommandTextFromArgs(command, { raw: "gpt-5.4" })).toBe("/model gpt-5.4");
    expect(serializeCommandArgs(command, { values: { model: "gpt-5.4" } })).toBe("gpt-5.4");
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
    expect(buildCommandTextFromArgs(requireChatCommand(key), { values })).toBe(expected);
  });
  it("resolves function-based choices with a default provider/model context", () => {
    const seen: CommandArgChoiceContext[] = [];
    const command = commandFixture(
      "think",
      [
        {
          name: "level",
          description: "level",
          type: "string",
          choices: (context) => {
            seen.push(context);
            return ["low", "high"];
          },
        },
      ],
      { argsMenu: "auto" },
    );
    const menu = requireCommandArgMenu({
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
    const seenChoice = expectDefined(seen.at(-1), "command choice context");
    expect(seenChoice.command.key).toBe("think");
    expect(seenChoice.arg.name).toBe("level");
    expect(typeof seenChoice.provider).toBe("string");
    expect(seenChoice.provider?.trim().length).toBeGreaterThan(0);
    expect(typeof seenChoice.model).toBe("string");
    expect(seenChoice.model?.trim().length).toBeGreaterThan(0);
    expect(seenChoice.agentRuntime).toBe("codex");
    expect(seenChoice.catalog?.length).toBe(0);
  });
  it.each([
    { model: "gpt-5.6-sol", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-terra", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-luna", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-luna", agentRuntime: "openclaw", supportsUltra: true },
  ])(
    "uses the $agentRuntime thinking profile for openai/$model native menus",
    ({ model, agentRuntime, supportsUltra }) => {
      const command = requireNativeCommand("think");
      const menu = requireCommandArgMenu({
        command,
        provider: "openai",
        model,
        agentRuntime,
      });
      expect(menu.choices.some((choice) => choice.value === "ultra")).toBe(supportsUltra);
    },
  );
  it.each([
    {
      source: "configured",
      cfg: {
        models: {
          providers: {
            ollama: { models: [{ id: "glm-5.2:cloud", name: "GLM 5.2 Cloud", reasoning: true }] },
          },
        },
      },
      catalog: undefined,
    },
    {
      source: "runtime",
      cfg: { agents: { defaults: { models: { "ollama/*": {} } } } },
      catalog: [
        { provider: "ollama", id: "glm-5.2:cloud", name: "GLM 5.2 Cloud", reasoning: true },
      ],
    },
  ])("uses $source model catalog reasoning for /think arg menus", ({ cfg, catalog }) => {
    installOllamaThinkingProvider();
    const command = requireNativeCommand("think");
    const menu = requireCommandArgMenu({
      command,
      cfg: cfg as never,
      provider: "ollama",
      model: "glm-5.2:cloud",
      catalog,
    });
    expect(menu.arg.name).toBe("level");
    expect(menu.choices.map((choice) => choice.value)).toEqual([
      "default",
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(formatCommandArgMenuTitle({ command, menu })).toBe(
      "Choose level for /think.\nOptions: default, off, low, medium, high, max.",
    );
  });
  it("uses configured model compat for /think arg menus", () => {
    const command = requireNativeCommand("think");
    const menu = requireCommandArgMenu({
      command,
      cfg: {
        models: {
          providers: {
            gmn: {
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT 5.4 via GMN",
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
                },
              ],
            },
          },
        },
      } as never,
      provider: "gmn",
      model: "gpt-5.4",
    });
    expect(menu.choices.map((choice) => choice.value)).toContain("xhigh");
    expect(formatCommandArgMenuTitle({ command, menu })).toContain("xhigh");
  });
  it("does not show menus when args were provided as raw text only", () => {
    const command = createUsageModeCommand("none", "on or off");
    const menu = resolveCommandArgMenu({ command, args: { raw: "on" }, cfg: {} as never });
    expect(menu).toBeNull();
  });
});
