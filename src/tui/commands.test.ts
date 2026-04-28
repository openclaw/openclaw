import { describe, expect, it } from "vitest";
import { getSlashCommands, helpText, parseCommand } from "./commands.js";

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

  it("exposes Crestodian operations as slash commands for autocomplete", () => {
    const commands = getSlashCommands();
    expect(commands.find((command) => command.name === "audit")?.description).toBe(
      "Show Crestodian audit log",
    );
    expect(commands.find((command) => command.name === "doctor")?.description).toBe(
      "Diagnose issues (Crestodian)",
    );
    expect(commands.find((command) => command.name === "health")?.description).toBe(
      "Check system health (Crestodian)",
    );
    expect(commands.find((command) => command.name === "setup")?.description).toBe(
      "Initialize OpenClaw configuration",
    );
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

  it("lists Crestodian shortcut slash commands", () => {
    const output = helpText();
    expect(output).toContain("/audit");
    expect(output).toContain("/doctor");
    expect(output).toContain("/health");
    expect(output).toContain("/setup");
  });
});
