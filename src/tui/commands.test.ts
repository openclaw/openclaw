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
      for (const command of [name, alias]) {
        expect(
          commands.find((entry) => entry.name === command)?.getArgumentCompletions?.(level),
        ).toEqual(choices(level));
      }
      expect(shouldSubmitExactArgumentCompletion(`/${alias} ${level}`, commands)).toBe(true);
    }
  });
  it.each([
    ["usage", "cost"],
    ["verbose", "full"],
    ["reasoning", "stream"],
  ])("submits an exact /%s %s completion", (name, level) => {
    const commands = getSlashCommands();
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
    const help = helpText({ local: true });
    for (const text of ["/commands", "/status"]) {
      expect(help).not.toContain(text);
    }
  });
});

describe("helpText", () => {
  it.each([
    [{ ...minimax, thinkingLevels: levels("off", "max") }, "/think <off|max|default>"],
    [minimax, "/think <off|adaptive|default>"],
  ] satisfies [Options, string][])("documents thinking levels for %j", (options, expected) => {
    expect(helpText(options)).toContain(expected);
  });
});
