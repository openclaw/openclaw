import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getCommandPath,
  getFlagValue,
  getPositiveIntFlagValue,
  getPrimaryCommand,
  hasHelpOrVersion,
  hasRootVersionAlias,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags and root -v alias only in root-flag contexts", () => {
    expect(hasHelpOrVersion(["node", "ironclaw", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "ironclaw", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "ironclaw", "-v"])).toBe(true);
    expect(hasRootVersionAlias(["node", "ironclaw", "-v", "chat"])).toBe(false);
  });

  it("extracts flag values across --name value and --name=value forms", () => {
    expect(getFlagValue(["node", "ironclaw", "--profile", "dev"], "--profile")).toBe("dev");
    expect(getFlagValue(["node", "ironclaw", "--profile=team-a"], "--profile")).toBe("team-a");
    expect(getFlagValue(["node", "ironclaw", "--profile", "--verbose"], "--profile")).toBeNull();
    expect(getFlagValue(["node", "ironclaw", "--profile="], "--profile")).toBeNull();
  });

  it("parses positive integer flags and rejects invalid numeric values", () => {
    expect(getPositiveIntFlagValue(["node", "ironclaw", "--port", "19001"], "--port")).toBe(19001);
    expect(getPositiveIntFlagValue(["node", "ironclaw", "--port", "0"], "--port")).toBeUndefined();
    expect(getPositiveIntFlagValue(["node", "ironclaw", "--port", "-1"], "--port")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "ironclaw", "--port", "abc"], "--port"),
    ).toBeUndefined();
  });

  it("derives command path while skipping leading flags and stopping at terminator", () => {
    // Low-level parser skips flag tokens but not their values.
    expect(getCommandPath(["node", "ironclaw", "--profile", "dev", "chat"], 2)).toEqual([
      "dev",
      "chat",
    ]);
    expect(getCommandPath(["node", "ironclaw", "config", "get"], 2)).toEqual(["config", "get"]);
    expect(getCommandPath(["node", "ironclaw", "--", "chat", "send"], 2)).toEqual([]);
    expect(getPrimaryCommand(["node", "ironclaw", "--verbose", "status"])).toBe("status");
  });

  it("builds parse argv consistently across runtime invocation styles", () => {
    expect(
      buildParseArgv({
        programName: "ironclaw",
        rawArgs: ["node", "cli.js", "status"],
      }),
    ).toEqual(["node", "cli.js", "status"]);

    expect(
      buildParseArgv({
        programName: "ironclaw",
        rawArgs: ["ironclaw", "status"],
      }),
    ).toEqual(["node", "ironclaw", "status"]);

    expect(
      buildParseArgv({
        programName: "ironclaw",
        rawArgs: ["node-22.12.0.exe", "cli.js", "agent", "run"],
      }),
    ).toEqual(["node-22.12.0.exe", "cli.js", "agent", "run"]);

    expect(
      buildParseArgv({
        programName: "ironclaw",
        rawArgs: ["bun", "cli.ts", "status"],
      }),
    ).toEqual(["bun", "cli.ts", "status"]);
  });

  it("skips state migration for read-only command paths and keeps mutations enabled for others", () => {
    expect(shouldMigrateStateFromPath([])).toBe(true);
    expect(shouldMigrateStateFromPath(["health"])).toBe(false);
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["sessions"])).toBe(false);
    expect(shouldMigrateStateFromPath(["config", "get"])).toBe(false);
    expect(shouldMigrateStateFromPath(["models", "list"])).toBe(false);
    expect(shouldMigrateStateFromPath(["memory", "status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agent"])).toBe(false);
    expect(shouldMigrateStateFromPath(["chat", "send"])).toBe(true);

    expect(shouldMigrateState(["node", "ironclaw", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "ironclaw", "chat", "send"])).toBe(true);
  });
});
