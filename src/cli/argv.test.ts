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
    expect(hasHelpOrVersion(["node", "EasyHub", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "EasyHub", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "EasyHub", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "EasyHub", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "EasyHub", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "EasyHub", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "EasyHub", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "EasyHub"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "EasyHub", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "EasyHub", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "EasyHub", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "EasyHub", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "EasyHub", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "EasyHub", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "EasyHub", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "EasyHub", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "EasyHub", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "EasyHub", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "EasyHub", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "EasyHub", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "EasyHub", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "EasyHub", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["node", "EasyHub", "status"],
    });
    expect(nodeArgv).toEqual(["node", "EasyHub", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["node-22", "EasyHub", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "EasyHub", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["node-22.2.0.exe", "EasyHub", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "EasyHub", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["node-22.2", "EasyHub", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "EasyHub", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["node-22.2.exe", "EasyHub", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "EasyHub", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["/usr/bin/node-22.2.0", "EasyHub", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "EasyHub", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["nodejs", "EasyHub", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "EasyHub", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["node-dev", "EasyHub", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "EasyHub", "node-dev", "EasyHub", "status"]);

    const directArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["EasyHub", "status"],
    });
    expect(directArgv).toEqual(["node", "EasyHub", "status"]);

    const bunArgv = buildParseArgv({
      programName: "EasyHub",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "EasyHub",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "EasyHub", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "EasyHub", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "EasyHub", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "EasyHub", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "EasyHub", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "EasyHub", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "EasyHub", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "EasyHub", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
