import { describe, expect, it } from "vitest";
import {
  getSlashCommands,
  helpText,
  parseCommand,
  shouldSubmitExactArgumentCompletion,
} from "./commands.js";

type Options = Parameters<typeof getSlashCommands>[0];
const levels = (...values: string[]) => values.map((value) => ({ id: value, label: value }));
const choices = (...values: string[]) => values.map((value) => ({ value, label: value }));
const findCommand = (name: string, options?: Options) =>
  getSlashCommands(options).find((entry) => entry.name === name);
const minimax = { provider: "minimax", model: "MiniMax-M3", thinkingLevels: [] };

describe("parseCommand", () => {
  it.each([
    ["/ELEV full", "elevated", "full"],
    ["/t high", "think", "high"],
    ["/side check this", "btw", "check this"],
    ["/followup first\nsecond", "followup", "first\nsecond"],
    ["/compact: focus on decisions", "compact", "focus on decisions"],
    ["/gwstatus", "gateway-status", ""],
    ["   ", "", ""],
  ])("parses %s", (input, name, args) => {
    expect(parseCommand(input)).toEqual({ name, args });
  });
  it.each([false, true])("discovers explicit followup with local=%s", (local) => {
    expect(helpText({ local })).toContain("/followup <message>");
    expect(getSlashCommands({ local }).some((command) => command.name === "followup")).toBe(true);
  });
  it("accepts but does not advertise the retired alias", () => {
    expect(parseCommand("/crestodian repair gateway")).toEqual({
      name: "openclaw",
      args: "repair gateway",
    });
    expect(getSlashCommands().map(({ name }) => name)).not.toContain("crestodian");
    expect(helpText()).not.toContain("/crestodian");
  });
});

describe("getSlashCommands", () => {
  it.each([false, true])("exposes host-local Chrome setup in local=%s mode", (local) => {
    const setup = findCommand("browser-setup", { local });
    expect(setup?.description).toContain("TUI process host (not the Gateway)");
    expect(setup?.getArgumentCompletions?.("")).toEqual(choices("inspect", "install", "verify"));
    expect(helpText({ local })).toContain("/browser-setup [inspect|install|verify]");
  });
  it.each([
    ["verbose", "o", ["on", "off"], undefined],
    ["activation", "a", ["always"], undefined],
    ["think", "default", ["default"], undefined],
    ["fast", "default", ["default"], undefined],
    [
      "think",
      "m",
      ["medium", "max"],
      { provider: "ollama", model: "qwen3:0.6b", thinkingLevels: levels("off", "medium", "max") },
    ],
    ["think", "", ["off", "adaptive", "default"], minimax],
  ] satisfies [string, string, string[], Options][])(
    "completes /%s %s",
    (name, prefix, expected, options) => {
      expect(findCommand(name, options)?.getArgumentCompletions?.(prefix)).toEqual(
        choices(...expected),
      );
    },
  );
  it.each([
    ["think", "t", "max"],
    ["verbose", "v", "full"],
    ["elevated", "elev", "ask"],
  ])("keeps /%s completion on /%s", (name, alias, level) => {
    for (const local of [false, true]) {
      const commands = getSlashCommands({ local, thinkingLevels: levels("max") });
      const canonical = commands.find((entry) => entry.name === name);
      const alternate = commands.find((entry) => entry.name === alias);
      expect(alternate?.getArgumentCompletions?.(level)).toEqual(
        canonical?.getArgumentCompletions?.(level),
      );
      expect(shouldSubmitExactArgumentCompletion(`/${alias} ${level}`, commands)).toBe(true);
    }
  });
  it("exposes usage cost in completion and help", () => {
    const commands = getSlashCommands({ local: true });
    const usage = commands.find(({ name }) => name === "usage");
    expect(usage?.description).toContain("cost summary");
    expect(usage?.getArgumentCompletions?.("co")).toEqual(choices("cost"));
    expect(shouldSubmitExactArgumentCompletion("/usage cost", commands)).toBe(true);
    expect(helpText({ local: true })).toContain("/usage <off|tokens|full|cost|reset|");
  });
  it.each([
    ["verbose", "full", "Set verbose on/off/full"],
    ["reasoning", "stream", "Set reasoning on/off/stream"],
  ])("describes and submits /%s %s", (name, level, description) => {
    const commands = getSlashCommands();
    expect(commands.find((entry) => entry.name === name)?.description).toBe(description);
    expect(findCommand(name)?.getArgumentCompletions?.(level)).toEqual(choices(level));
    expect(shouldSubmitExactArgumentCompletion(`/${name} ${level}`, commands)).toBe(true);
  });
  it.each([
    ["gpt-5.6-sol", "codex"],
    ["gpt-5.6-terra", "codex"],
    ["gpt-5.6-luna", "codex"],
    ["gpt-5.6-luna", "openclaw"],
  ])("offers ultra for openai/%s on %s", (model, agentRuntime) => {
    const completions = findCommand("think", {
      provider: "openai",
      model,
      agentRuntime,
      thinkingLevels: [],
    })?.getArgumentCompletions?.("");
    if (!Array.isArray(completions)) {
      throw new Error("expected synchronous thinking-level completions");
    }
    expect(completions.some((choice) => choice.value === "ultra")).toBe(true);
  });
  it("merges dynamic gateway commands", () => {
    const commands = getSlashCommands({
      dynamicCommands: [
        {
          name: "dreaming",
          textAliases: ["/dreaming", "/dream"],
          description: "Enable or disable memory dreaming.",
          source: "plugin",
          scope: "both",
          acceptsArgs: true,
        },
      ],
    });
    expect(commands.find(({ name }) => name === "dreaming")?.description).toBe(
      "Enable or disable memory dreaming.",
    );
    expect(
      commands.find(({ name }) => name === "dream")?.getArgumentCompletions?.(""),
    ).toBeUndefined();
  });
  it("only advertises shared commands local mode can route", () => {
    const names = getSlashCommands({ local: true }).map(({ name }) => name);
    expect(names).toEqual(
      expect.not.arrayContaining(["commands", "status", "compact", "context", "tools"]),
    );
    expect(names).toEqual(
      expect.arrayContaining(["goal", "btw", "side", "queue", "stop", "t", "auth"]),
    );
    expect(getSlashCommands().map(({ name }) => name)).not.toContain("auth");
  });
});

describe("helpText", () => {
  it.each([
    [
      "session thinking levels",
      { ...minimax, thinkingLevels: levels("off", "max") },
      ["/think <off|max|default>"],
      [],
    ],
    ["provider thinking fallback", minimax, ["/think <off|adaptive|default>"], []],
    [
      "default resets",
      undefined,
      [
        "/model <provider/model|default>",
        /\/think <[^>]+\|default>/u,
        "/fast <status|auto|on|off|default>",
      ],
      [],
    ],
    [
      "required local arguments",
      { local: true },
      ["/goal start <objective>", "/goal edit <objective>", "/btw <side question>"],
      ["/btw [side question]"],
    ],
    ["local command visibility", { local: true }, [], ["/commands", "/status"]],
  ] satisfies [string, Options, (string | RegExp)[], string[]][])(
    "documents %s",
    (_name, options, included, excluded) => {
      const output = helpText(options);
      for (const text of included) {
        if (typeof text === "string") {
          expect(output).toContain(text);
        } else {
          expect(output).toMatch(text);
        }
      }
      for (const text of excluded) {
        expect(output).not.toContain(text);
      }
    },
  );
});
