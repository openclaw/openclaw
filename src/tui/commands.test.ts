// Verifies TUI command definitions and parser metadata.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getSlashCommands,
  helpText,
  parseCommand,
  shouldSubmitExactArgumentCompletion,
} from "./commands.js";

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
    const retiredCommand = "/crestodian repair gateway"; // hidden alias
    expect(parseCommand(retiredCommand)).toEqual({
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
    const command = getSlashCommands({ local }).find((entry) => entry.name === "browser-setup");
    expect(command?.description).toContain("TUI process host (not the Gateway)");
    expect(command?.getArgumentCompletions?.("")).toEqual([
      { value: "inspect", label: "inspect" },
      { value: "install", label: "install" },
      { value: "verify", label: "verify" },
    ]);
    expect(helpText({ local })).toContain("/browser-setup [inspect|install|verify]");
  });
  beforeAll(() => {
    // Provider thinking policies are process-stable; warm the fallback before timing assertions.
    getSlashCommands({ provider: "minimax", model: "MiniMax-M3", thinkingLevels: [] });
  });

  it("provides level completions for built-in toggles", () => {
    const commands = getSlashCommands();
    const verbose = commands.find((command) => command.name === "verbose");
    const activation = commands.find((command) => command.name === "activation");
    expect(verbose?.getArgumentCompletions?.("o")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    expect(activation?.getArgumentCompletions?.("a")).toEqual([
      { value: "always", label: "always" },
    ]);
  });

  it.each(["think", "fast"])("offers /%s default to clear the session override", (name) => {
    const command = getSlashCommands().find((candidate) => candidate.name === name);

    expect(command?.getArgumentCompletions?.("default")).toEqual([
      { value: "default", label: "default" },
    ]);
  });

  it.each([
    { command: "think", alias: "t", level: "max" },
    { command: "verbose", alias: "v", level: "full" },
    { command: "elevated", alias: "elev", level: "ask" },
  ])("keeps /$command $level completion on its /$alias alias", ({ command, alias, level }) => {
    for (const local of [false, true]) {
      const commands = getSlashCommands({
        local,
        thinkingLevels: [{ id: "max", label: "max" }],
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
    expect(usage?.getArgumentCompletions?.("co")).toEqual([{ value: "cost", label: "cost" }]);
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
      expect(command?.getArgumentCompletions?.(level)).toEqual([{ value: level, label: level }]);
      expect(shouldSubmitExactArgumentCompletion(`/${commandName} ${level}`, commands)).toBe(true);
    },
  );

  it("uses session-provided thinking levels for completions", () => {
    const commands = getSlashCommands({
      provider: "ollama",
      model: "qwen3:0.6b",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "medium", label: "medium" },
        { id: "max", label: "max" },
      ],
    });
    const think = commands.find((command) => command.name === "think");
    expect(think?.getArgumentCompletions?.("m")).toEqual([
      { value: "medium", label: "medium" },
      { value: "max", label: "max" },
    ]);
  });

  it("falls back to provider-resolved levels when thinkingLevels is empty (#76482)", () => {
    const commands = getSlashCommands({
      provider: "minimax",
      model: "MiniMax-M3",
      thinkingLevels: [], // empty from lightweight session row
    });
    const think = commands.find((command) => command.name === "think");
    // Should fall back to listThinkingLevelLabels, not return empty completions
    const completions = think?.getArgumentCompletions?.("");
    expect(Array.isArray(completions)).toBe(true);
    if (!Array.isArray(completions)) {
      throw new Error("expected synchronous thinking-level completions");
    }
    expect(completions).toEqual([
      { value: "off", label: "off" },
      { value: "adaptive", label: "adaptive" },
      { value: "default", label: "default" },
    ]);
  });

  it.each([
    { model: "gpt-5.6-sol", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-terra", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-luna", agentRuntime: "codex", supportsUltra: true },
    { model: "gpt-5.6-luna", agentRuntime: "openclaw", supportsUltra: true },
  ])(
    "uses the $agentRuntime profile for openai/$model thinking completions",
    ({ model, agentRuntime, supportsUltra }) => {
      const think = getSlashCommands({
        provider: "openai",
        model,
        agentRuntime,
        thinkingLevels: [],
      }).find((command) => command.name === "think");
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

    expect(
      helpText({
        ...model,
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "max", label: "max" },
        ],
      }),
    ).toContain("/think <off|max|default>");
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
