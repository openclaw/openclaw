import { describe, expect, it } from "vitest";

import {
  buildParseArgv,
  getCommandPath,
  getPrimaryCommand,
  hasHelpOrVersion,
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
