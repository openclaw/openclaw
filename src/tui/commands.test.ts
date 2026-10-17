import { describe, expect, it } from "vitest";
import {
  getSlashCommands,
  helpText,
  parseCommand,
  shouldSubmitExactArgumentCompletion,
} from "./commands.js";

const levels = (...values: string[]) => values.map((value) => ({ id: value, label: value }));
const choices = (...values: string[]) => values.map((value) => ({ value, label: value }));
const findCommand = (name: string, options?: Parameters<typeof getSlashCommands>[0]) =>
  getSlashCommands(options).find((entry) => entry.name === name);

describe("parseCommand", () => {
  it("normalizes aliases and keeps command args", () => {
    expect(parseCommand("/ELEV full")).toEqual({ name: "elevated", args: "full" });
    expect(parseCommand("/t high")).toEqual({ name: "think", args: "high" });
    expect(parseCommand("/side check this")).toEqual({ name: "btw", args: "check this" });
    expect(parseCommand("/compact: focus on decisions")).toEqual({
      name: "compact",
      args: "focus on decisions",
    });
  });

  it("normalizes gateway-status aliases", () => {
    expect(parseCommand("/gwstatus")).toEqual({ name: "gateway-status", args: "" });
  });

  it("accepts the hidden retired-name alias", () => {
    expect(parseCommand("/crestodian repair gateway")).toEqual({
      name: "openclaw",
      args: "repair gateway",
    });
    expect(getSlashCommands().map((command) => command.name)).not.toContain("crestodian"); // hidden alias
    expect(helpText()).not.toContain("/crestodian"); // hidden alias
  });

  it("returns empty name for empty input", () => {
    expect(parseCommand("   ")).toEqual({ name: "", args: "" });
  });
});

describe("getSlashCommands", () => {
  it.each([false, true])("exposes host-local Chrome setup in local=%s mode", (local) => {
    const setup = findCommand("browser-setup", { local });
    expect(setup?.description).toContain("TUI process host (not the Gateway)");
    expect(setup?.getArgumentCompletions?.("")).toEqual(choices("inspect", "install", "verify"));
    expect(helpText({ local })).toContain("/browser-setup [inspect|install|verify]");
  });

  it("provides level completions for built-in toggles", () => {
    expect(findCommand("verbose")?.getArgumentCompletions?.("o")).toEqual(choices("on", "off"));
    expect(findCommand("activation")?.getArgumentCompletions?.("a")).toEqual(choices("always"));
  });

  it.each(["think", "fast"])("offers /%s default to clear the session override", (name) => {
    expect(findCommand(name)?.getArgumentCompletions?.("default")).toEqual(choices("default"));
  });

  it.each([
    { command: "think", alias: "t", level: "max" },
    { command: "verbose", alias: "v", level: "full" },
    { command: "elevated", alias: "elev", level: "ask" },
  ])("keeps /$command $level completion on its /$alias alias", ({ command, alias, level }) => {
    for (const local of [false, true]) {
      const commands = getSlashCommands({
        local,
        thinkingLevels: levels("max"),
      });
      const canonical = commands.find((candidate) => candidate.name === command);
      const alternate = commands.find((candidate) => candidate.name === alias);

      expect(alternate?.getArgumentCompletions?.(level)).toEqual(
        canonical?.getArgumentCompletions?.(level),
      );
      expect(shouldSubmitExactArgumentCompletion(`/${alias} ${level}`, commands)).toBe(true);
    }
  });

  it("exposes usage cost in completion and help", () => {
    const commands = getSlashCommands({ local: true });
    const usage = commands.find((command) => command.name === "usage");

    expect(usage?.description).toContain("cost summary");
    expect(usage?.getArgumentCompletions?.("co")).toEqual(choices("cost"));
    expect(shouldSubmitExactArgumentCompletion("/usage cost", commands)).toBe(true);
    expect(helpText({ local: true })).toContain("/usage <off|tokens|full|cost|reset|");
  });

  it.each([
    { commandName: "verbose", level: "full", description: "Set verbose on/off/full" },
    { commandName: "reasoning", level: "stream", description: "Set reasoning on/off/stream" },
  ])(
    "exposes and submits the canonical /$commandName $level completion",
    ({ commandName, level, description }) => {
      const commands = getSlashCommands();
      const command = commands.find((candidate) => candidate.name === commandName);

      expect(command?.description).toBe(description);
      expect(command?.getArgumentCompletions?.(level)).toEqual(choices(level));
      expect(shouldSubmitExactArgumentCompletion(`/${commandName} ${level}`, commands)).toBe(true);
    },
  );

  it("uses session-provided thinking levels for completions", () => {
    const think = findCommand("think", {
      provider: "ollama",
      model: "qwen3:0.6b",
      thinkingLevels: levels("off", "medium", "max"),
    });
    expect(think?.getArgumentCompletions?.("m")).toEqual(choices("medium", "max"));
  });

  it("falls back to provider-resolved levels when thinkingLevels is empty (#76482)", () => {
    const think = findCommand("think", {
      provider: "minimax",
      model: "MiniMax-M3",
      thinkingLevels: [], // empty from lightweight session row
    });
    expect(think?.getArgumentCompletions?.("")).toEqual(choices("off", "adaptive", "default"));
  });

  it.each([
    { model: "gpt-5.6-sol", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-terra", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-luna", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-luna", agentRuntime: "openclaw", supportsUltra: true },
  ])(
    "uses the $agentRuntime profile for openai/$model thinking completions",
    ({ model, agentRuntime, supportsUltra }) => {
      const think = findCommand("think", {
        provider: "openai",
        model,
        agentRuntime,
        thinkingLevels: [],
      });
      const completions = think?.getArgumentCompletions?.("");
      if (!Array.isArray(completions)) {
        throw new Error("expected synchronous thinking-level completions");
      }

      expect(completions.some((choice) => choice.value === "ultra")).toBe(supportsUltra);
    },
  );

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

    expect(commands.find((command) => command.name === "dreaming")?.description).toBe(
      "Enable or disable memory dreaming.",
    );
    expect(
      commands.find((command) => command.name === "dream")?.getArgumentCompletions?.(""),
    ).toBeUndefined();
  });

  it("only advertises shared commands that local mode can route", () => {
    const names = getSlashCommands({ local: true }).map((command) => command.name);

    expect(names).toEqual(
      expect.not.arrayContaining(["commands", "status", "compact", "context", "tools"]),
    );
    expect(names).toEqual(
      expect.arrayContaining(["goal", "btw", "side", "queue", "stop", "t", "auth"]),
    );
    expect(getSlashCommands().map((command) => command.name)).not.toContain("auth");
  });
});

describe("helpText", () => {
  it("uses session-supported thinking levels in help before the provider fallback", () => {
    const model = { provider: "minimax", model: "MiniMax-M3" };

    expect(helpText({ ...model, thinkingLevels: levels("off", "max") })).toContain(
      "/think <off|max|default>",
    );
    expect(helpText({ ...model, thinkingLevels: [] })).toContain("/think <off|adaptive|default>");
  });

  it("documents default reset values for model, thinking, and fast mode", () => {
    const output = helpText();

    expect(output).toContain("/model <provider/model|default>");
    expect(output).toMatch(/\/think <[^>]+\|default>/u);
    expect(output).toContain("/fast <status|auto|on|off|default>");
  });

  it("shows required arguments in shared command help", () => {
    const output = helpText({ local: true });

    expect(output).toContain("/goal start <objective>");
    expect(output).toContain("/goal edit <objective>");
    expect(output).toContain("/btw <side question>");
    expect(output).not.toContain("/btw [side question]");
  });

  it("does not advertise Gateway-owned commands in local mode", () => {
    const output = helpText({ local: true });

    expect(output).not.toContain("/commands");
    expect(output).not.toContain("/status");
  });
});
