import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "smart-agent-neo", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "smart-agent-neo", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "smart-agent-neo", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "smart-agent-neo", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "smart-agent-neo", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "smart-agent-neo", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "smart-agent-neo", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "smart-agent-neo"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "smart-agent-neo", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "smart-agent-neo", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "smart-agent-neo", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "smart-agent-neo", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "smart-agent-neo", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "smart-agent-neo", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "smart-agent-neo", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "smart-agent-neo", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "smart-agent-neo", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "smart-agent-neo", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "smart-agent-neo", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "smart-agent-neo", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "smart-agent-neo", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "smart-agent-neo", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["node", "smart-agent-neo", "status"],
    });
    expect(nodeArgv).toEqual(["node", "smart-agent-neo", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["node-22", "smart-agent-neo", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "smart-agent-neo", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["node-22.2.0.exe", "smart-agent-neo", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "smart-agent-neo", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["node-22.2", "smart-agent-neo", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "smart-agent-neo", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["node-22.2.exe", "smart-agent-neo", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "smart-agent-neo", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["/usr/bin/node-22.2.0", "smart-agent-neo", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "smart-agent-neo", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["nodejs", "smart-agent-neo", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "smart-agent-neo", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["node-dev", "smart-agent-neo", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "smart-agent-neo", "node-dev", "smart-agent-neo", "status"]);

    const directArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["smart-agent-neo", "status"],
    });
    expect(directArgv).toEqual(["node", "smart-agent-neo", "status"]);

    const bunArgv = buildParseArgv({
      programName: "smart-agent-neo",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "smart-agent-neo",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "smart-agent-neo", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "smart-agent-neo", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "config", "get", "update"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "config", "unset", "update"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "models", "list"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "models", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "smart-agent-neo", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "smart-agent-neo", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["config", "get"])).toBe(false);
    expect(shouldMigrateStateFromPath(["models", "status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
