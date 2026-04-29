import { describe, expect, it } from "vitest";
import { getBuiltinSlashCommands, helpText, parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("normalizes aliases and keeps command args", () => {
    expect(parseCommand("/elev full")).toEqual({ name: "elevated", args: "full" });
  });

  it("normalizes gateway-status aliases", () => {
    expect(parseCommand("/gwstatus")).toEqual({ name: "gateway-status", args: "" });
  });

  it("returns empty name for empty input", () => {
    expect(parseCommand("   ")).toEqual({ name: "", args: "" });
  });
});

describe("getBuiltinSlashCommands", () => {
  it("provides level completions for built-in toggles", () => {
    const commands = getBuiltinSlashCommands();
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

  it("exposes gateway status and crestodian on the built-in command path", () => {
    const commands = getBuiltinSlashCommands();
    const gatewayStatus = commands.find((command) => command.name === "gateway-status");
    const crestodian = commands.find((command) => command.name === "crestodian");
    expect(gatewayStatus?.description).toBe("Show gateway status summary");
    expect(crestodian?.description).toBe("Return to Crestodian");
  });

  it("uses session-provided thinking levels for completions", () => {
    const commands = getBuiltinSlashCommands({
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
});
