import { describe, expect, it } from "vitest";
import {
  detectNestedOpenClawStateRoot,
  formatNestedOpenClawStateRootWarning,
} from "./state-root-diagnostics.js";

describe("detectNestedOpenClawStateRoot", () => {
  it("detects nested .openclaw segments in the db path", () => {
    const diagnostic = detectNestedOpenClawStateRoot({
      stateDir: "/Users/test/.openclaw/.openclaw",
      dbPath: "/Users/test/.openclaw/.openclaw/memory/main.sqlite",
    });

    expect(diagnostic).toEqual({
      dbPath: "/Users/test/.openclaw/.openclaw/memory/main.sqlite",
      stateDir: "/Users/test/.openclaw/.openclaw",
      expectedDbPath: "/Users/test/.openclaw/memory/main.sqlite",
      outerStateDir: "/Users/test/.openclaw",
      reason: "nested-db-path",
    });
  });

  it("detects a state dir nested under an existing .openclaw dir", () => {
    const diagnostic = detectNestedOpenClawStateRoot({
      stateDir: "/Users/test/.openclaw/dev-state",
      dbPath: "/Users/test/.openclaw/dev-state/memory/codex.sqlite",
    });

    expect(diagnostic).toEqual({
      dbPath: "/Users/test/.openclaw/dev-state/memory/codex.sqlite",
      stateDir: "/Users/test/.openclaw/dev-state",
      expectedDbPath: "/Users/test/.openclaw/memory/codex.sqlite",
      outerStateDir: "/Users/test/.openclaw",
      reason: "nested-state-dir",
    });
  });

  it("ignores the canonical state root", () => {
    const diagnostic = detectNestedOpenClawStateRoot({
      stateDir: "/Users/test/.openclaw",
      dbPath: "/Users/test/.openclaw/memory/main.sqlite",
    });

    expect(diagnostic).toBeNull();
  });

  it("formats a visible warning", () => {
    const diagnostic = detectNestedOpenClawStateRoot({
      stateDir: "/Users/test/.openclaw/.openclaw",
      dbPath: "/Users/test/.openclaw/.openclaw/memory/main.sqlite",
    });

    expect(diagnostic).not.toBeNull();
    const warning = formatNestedOpenClawStateRootWarning(diagnostic!);
    expect(warning).toContain(
      "WARNING: state root appears to be nested inside another .openclaw dir",
    );
    expect(warning).toContain("OPENCLAW_HOME");
    expect(warning).toContain("/Users/test/.openclaw/memory/main.sqlite");
  });
});
