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
    expect(hasHelpOrVersion(["node", "openclaw", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "openclaw", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "openclaw", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "openclaw", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "openclaw", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "openclaw", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "openclaw", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "openclaw"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "openclaw", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "openclaw", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "openclaw", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "openclaw", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "openclaw", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "openclaw", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "openclaw", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "openclaw", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "openclaw", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "openclaw", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "openclaw", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "openclaw", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "openclaw", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "openclaw", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["node", "openclaw", "status"],
    });
    expect(nodeArgv).toEqual(["node", "openclaw", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["node-22", "openclaw", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "openclaw", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["node-22.2.0.exe", "openclaw", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "openclaw", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["node-22.2", "openclaw", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "openclaw", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["node-22.2.exe", "openclaw", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "openclaw", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["/usr/bin/node-22.2.0", "openclaw", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "openclaw", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["nodejs", "openclaw", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "openclaw", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["node-dev", "openclaw", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "openclaw", "node-dev", "openclaw", "status"]);

    const directArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["openclaw", "status"],
    });
    expect(directArgv).toEqual(["node", "openclaw", "status"]);

    const bunArgv = buildParseArgv({
      programName: "openclaw",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "openclaw",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "openclaw", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "openclaw", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "openclaw", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "openclaw", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "openclaw", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "openclaw", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "openclaw", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "openclaw", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
