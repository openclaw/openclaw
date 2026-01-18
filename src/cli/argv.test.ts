import { describe, expect, it } from "vitest";

import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  hasHelpOrVersion,
  hasFlag,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "clawdbot", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "clawdbot", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "clawdbot", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "clawdbot", "status", "--json"], 2)).toEqual([
      "status",
    ]);
    expect(getCommandPath(["node", "clawdbot", "agents", "list"], 2)).toEqual([
      "agents",
      "list",
    ]);
    expect(getCommandPath(["node", "clawdbot", "status", "--", "ignored"], 2)).toEqual([
      "status",
    ]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "clawdbot", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "clawdbot"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "clawdbot", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "clawdbot", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "clawdbot", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "clawdbot", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "clawdbot", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "clawdbot", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "clawdbot", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "clawdbot",
      rawArgs: ["node", "clawdbot", "status"],
    });
    expect(nodeArgv).toEqual(["node", "clawdbot", "status"]);

    const directArgv = buildParseArgv({
      programName: "clawdbot",
      rawArgs: ["clawdbot", "status"],
    });
    expect(directArgv).toEqual(["node", "clawdbot", "status"]);

    const bunArgv = buildParseArgv({
      programName: "clawdbot",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "clawdbot",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "clawdbot", "status"]);
  });
});
