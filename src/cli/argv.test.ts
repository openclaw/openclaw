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
    expect(hasHelpOrVersion(["node", "dna", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "dna", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "dna", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "dna", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "dna", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "dna", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "dna", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "dna"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "dna", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "dna", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "dna", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "dna", "status", "--timeout=2500"], "--timeout")).toBe("2500");
    expect(getFlagValue(["node", "dna", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "dna", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "dna", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "dna", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "dna", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "dna", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "dna", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "dna", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "dna", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "dna", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["node", "dna", "status"],
    });
    expect(nodeArgv).toEqual(["node", "dna", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["node-22", "dna", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "dna", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["node-22.2.0.exe", "dna", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "dna", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["node-22.2", "dna", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "dna", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["node-22.2.exe", "dna", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "dna", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["/usr/bin/node-22.2.0", "dna", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "dna", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["nodejs", "dna", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "dna", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["node-dev", "dna", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "dna", "node-dev", "dna", "status"]);

    const directArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["dna", "status"],
    });
    expect(directArgv).toEqual(["node", "dna", "status"]);

    const bunArgv = buildParseArgv({
      programName: "dna",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "dna",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "dna", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "dna", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "dna", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "dna", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "dna", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "dna", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "dna", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "dna", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
