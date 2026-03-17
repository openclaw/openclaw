import { describe, expect, it } from "vitest";
import { getSlashCommands, helpText, parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("normalizes aliases and keeps command args", () => {
    expect(parseCommand("/elev full")).toEqual({ name: "elevated", args: "full" });
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

  it("provides alias completions from saved TUI aliases", () => {
    const commands = getSlashCommands({
      aliases: {
        review: "check the PR",
        shipit: "merge it",
      },
    });
    const alias = commands.find((command) => command.name === "alias");
    const unalias = commands.find((command) => command.name === "unalias");
    expect(alias?.getArgumentCompletions?.("r")).toEqual([{ value: "review", label: "review" }]);
    expect(unalias?.getArgumentCompletions?.("s")).toEqual([{ value: "shipit", label: "shipit" }]);
  });
});

describe("helpText", () => {
  it("includes slash command help for aliases", () => {
    const output = helpText();
    expect(output).toContain("/elevated <on|off|ask|full>");
    expect(output).toContain("/elev <on|off|ask|full>");
    expect(output).toContain("/alias [name] [prompt]");
    expect(output).toContain("/unalias <name>");
  });
});
