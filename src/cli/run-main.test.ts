import { describe, expect, it } from "vitest";
import {
  rewriteUpdateFlagArgv,
  resolveMissingPluginCommandMessage,
  shouldEnsureCliPath,
  shouldUseRootHelpFastPath,
} from "./run-main.js";

describe("rewriteUpdateFlagArgv", () => {
  it("leaves argv unchanged when --update is absent", () => {
    const argv = ["node", "entry.js", "status"];
    expect(rewriteUpdateFlagArgv(argv)).toBe(argv);
  });

  it("rewrites --update into the update command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update"])).toEqual([
      "node",
      "entry.js",
      "update",
    ]);
  });

  it("preserves global flags that appear before --update", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--profile", "p", "--update"])).toEqual([
      "node",
      "entry.js",
      "--profile",
      "p",
      "update",
    ]);
  });

  it("keeps update options after the rewritten command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update", "--json"])).toEqual([
      "node",
      "entry.js",
      "update",
      "--json",
    ]);
  });
});

describe("shouldEnsureCliPath", () => {
  it("skips path bootstrap for help/version invocations", () => {
    expect(shouldEnsureCliPath(["node", "openclaw", "--help"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "-V"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "-v"])).toBe(false);
  });

  it("skips path bootstrap for read-only fast paths", () => {
    expect(shouldEnsureCliPath(["node", "openclaw", "status"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "--log-level", "debug", "status"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "sessions", "--json"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "config", "get", "update"])).toBe(false);
    expect(shouldEnsureCliPath(["node", "openclaw", "models", "status", "--json"])).toBe(false);
  });

  it("keeps path bootstrap for mutating or unknown commands", () => {
    expect(shouldEnsureCliPath(["node", "openclaw", "message", "send"])).toBe(true);
    expect(shouldEnsureCliPath(["node", "openclaw", "voicecall", "status"])).toBe(true);
    expect(shouldEnsureCliPath(["node", "openclaw", "acp", "-v"])).toBe(true);
  });
});

describe("shouldUseRootHelpFastPath", () => {
  it("uses the fast path for root help only", () => {
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "--help"])).toBe(true);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "--profile", "work", "-h"])).toBe(true);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "status", "--help"])).toBe(false);
    expect(shouldUseRootHelpFastPath(["node", "openclaw", "--help", "status"])).toBe(false);
  });
});

describe("resolveMissingPluginCommandMessage", () => {
  it("explains plugins.allow misses for a bundled plugin command", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          allow: ["telegram"],
        },
      }),
    ).toContain('`plugins.allow` excludes "browser"');
  });

  it("explains explicit bundled plugin disablement", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      }),
    ).toContain("plugins.entries.browser.enabled=false");
  });

  it("returns null when the bundled plugin command is already allowed", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          allow: ["browser"],
        },
      }),
    ).toBeNull();
  });
});
