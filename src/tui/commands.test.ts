// Verifies TUI command definitions and parser metadata.
import { describe, expect, it } from "vitest";
import { getSlashCommands, helpText, parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("normalizes aliases and keeps command args", () => {
    expect(parseCommand("/elev full")).toEqual({ name: "elevated", args: "full" });
  });

  it("treats colon-form slash command args as command args", () => {
    expect(parseCommand("/model: openai/gpt-5.5")).toEqual({
      name: "model",
      args: "openai/gpt-5.5",
    });
    expect(parseCommand("/think: high")).toEqual({ name: "think", args: "high" });
    expect(parseCommand("/compact: focus on decisions")).toEqual({
      name: "compact",
      args: "focus on decisions",
    });
  });

  it("normalizes gateway-status aliases", () => {
    expect(parseCommand("/gwstatus")).toEqual({ name: "gateway-status", args: "" });
  });

  it("returns empty name for empty input", () => {
    expect(parseCommand("   ")).toEqual({ name: "", args: "" });
  });
});

describe("getSlashCommands", () => {
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

  it("keeps session status on the shared command path and exposes gateway status separately", () => {
    const commands = getSlashCommands();
    const status = commands.find((command) => command.name === "status");
    const gatewayStatus = commands.find((command) => command.name === "gateway-status");
    const crestodian = commands.find((command) => command.name === "crestodian");
    expect(status?.description).toBe("Show current status.");
    expect(gatewayStatus?.description).toBe("Show gateway status summary");
    expect(crestodian?.description).toBe("Return to Crestodian");
  });

  it("distinguishes new-session and reset command descriptions", () => {
    const commands = getSlashCommands();
    const newSession = commands.find((command) => command.name === "new");
    const reset = commands.find((command) => command.name === "reset");
    expect(newSession?.description).toBe("Spawn a new isolated session");
    expect(reset?.description).toBe("Reset the current session");
  });

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

  it("falls back to provider-resolved levels when thinkingLevels is empty (#76482)", async () => {
    const commands = getSlashCommands({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      thinkingLevels: [], // empty from lightweight session row
    });
    const think = commands.find((command) => command.name === "think");
    // Should fall back to listThinkingLevelLabels, not return empty completions
    const completions = await think?.getArgumentCompletions?.("");
    expect(completions?.length).toBeGreaterThan(0);
  });

  it("merges dynamic gateway commands", () => {
    const commands = getSlashCommands({
      dynamicCommands: [
        {
          name: "dreaming",
          textAliases: ["/dreaming"],
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
  });

  it("filters unsupported shared commands from local embedded discovery", () => {
    const names = getSlashCommands({ local: true }).map((command) => command.name);
    expect(names).toContain("status");
    expect(names).toContain("btw");
    expect(names).toContain("side");
    expect(names).toContain("t");
    expect(names).toContain("stop");
    expect(names).not.toContain("commands");
    expect(names).not.toContain("compact");
    expect(names).not.toContain("context");
  });
});

describe("helpText", () => {
  it("includes slash command help for aliases", () => {
    const output = helpText();
    expect(output).toContain("/elevated <on|off|ask|full>");
    expect(output).toContain("/elev <on|off|ask|full>");
    expect(output).toContain("/gateway-status");
    expect(output).toContain("/gwstatus");
    expect(output).toContain("/crestodian [request]");
  });

  it("does not advertise /commands in local embedded help", () => {
    const output = helpText({ local: true });
    expect(output).toContain("/status");
    expect(output).not.toContain("/commands");
  });
});
