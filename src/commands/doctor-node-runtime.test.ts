/**
 * Tests for doctor-node-runtime.ts — Node.js runtime diagnostics
 * for the `openclaw doctor` health contribution.
 *
 * Test groups:
 *   - detectVersionManagerName: version manager path detection
 *   - collectNodeRuntimeDiagnostics: data collection with injected deps
 *   - buildNodeRuntimeWarnings: warning generation for various scenarios
 *   - buildNodeRuntimeSummary: summary line formatting
 */

import { describe, expect, it } from "vitest";
import type { RuntimeDetails } from "../infra/runtime-guard.js";
import {
  buildNodeRuntimeSummary,
  buildNodeRuntimeWarnings,
  collectNodeRuntimeDiagnostics,
  detectVersionManagerName,
  type NodeRuntimeDiagnostics,
} from "./doctor-node-runtime.js";

// ─── Helpers ────────────────────────────────────────────────────

/** Build a minimal RuntimeDetails for testing. */
function makeRuntimeDetails(overrides: Partial<RuntimeDetails> = {}): RuntimeDetails {
  return {
    kind: "node",
    version: "24.14.0",
    execPath: "/usr/local/bin/node",
    pathEnv: "/usr/local/bin:/usr/bin",
    ...overrides,
  };
}

/** Build a minimal NodeRuntimeDiagnostics for testing. */
function makeDiag(overrides: Partial<NodeRuntimeDiagnostics> = {}): NodeRuntimeDiagnostics {
  return {
    version: "24.14.0",
    major: 24,
    execPath: "/usr/local/bin/node",
    versionManaged: false,
    versionManagerHint: null,
    satisfiesMinimum: true,
    runtimeDetails: makeRuntimeDetails(),
    ...overrides,
  };
}

// ─── detectVersionManagerName ───────────────────────────────────

describe("detectVersionManagerName", () => {
  it("returns null for null execPath", () => {
    expect(detectVersionManagerName(null)).toBeNull();
  });

  it("returns null for system install path", () => {
    expect(detectVersionManagerName("/usr/local/bin/node")).toBeNull();
  });

  it("detects nvm", () => {
    expect(detectVersionManagerName("/home/user/.nvm/versions/node/v24.14.0/bin/node")).toBe("nvm");
  });

  it("detects fnm", () => {
    expect(detectVersionManagerName("/home/user/.fnm/node-versions/v24.14.0/bin/node")).toBe("fnm");
  });

  it("detects volta", () => {
    expect(detectVersionManagerName("/home/user/.volta/tools/image/node/24.14.0/bin/node")).toBe(
      "volta",
    );
  });

  it("detects asdf", () => {
    expect(detectVersionManagerName("/home/user/.asdf/installs/nodejs/24.14.0/bin/node")).toBe(
      "asdf",
    );
  });

  it("detects n", () => {
    expect(detectVersionManagerName("/home/user/.n/bin/node")).toBe("n");
  });

  it("detects nodenv", () => {
    expect(detectVersionManagerName("/home/user/.nodenv/versions/24.14.0/bin/node")).toBe("nodenv");
  });

  it("detects nodebrew", () => {
    expect(detectVersionManagerName("/home/user/.nodebrew/current/bin/node")).toBe("nodebrew");
  });

  it("detects nvs", () => {
    expect(detectVersionManagerName("/home/user/nvs/node/24.14.0/bin/node")).toBe("nvs");
  });

  it("handles Windows-style backslash paths", () => {
    expect(
      detectVersionManagerName("C:\\Users\\james\\.nvm\\versions\\node\\v24.14.0\\node.exe"),
    ).toBe("nvm");
  });
});

// ─── collectNodeRuntimeDiagnostics ──────────────────────────────

describe("collectNodeRuntimeDiagnostics", () => {
  it("collects diagnostics from injected runtime details", () => {
    const details = makeRuntimeDetails({
      version: "24.14.0",
      execPath: "/home/user/.nvm/versions/node/v24.14.0/bin/node",
    });
    const diag = collectNodeRuntimeDiagnostics({ runtimeDetails: details });
    expect(diag.version).toBe("24.14.0");
    expect(diag.major).toBe(24);
    expect(diag.satisfiesMinimum).toBe(true);
    expect(diag.versionManaged).toBe(true);
    expect(diag.versionManagerHint).toBe("nvm");
  });

  it("handles unknown runtime version", () => {
    const details = makeRuntimeDetails({ version: null, kind: "unknown" });
    const diag = collectNodeRuntimeDiagnostics({ runtimeDetails: details });
    expect(diag.version).toBeNull();
    expect(diag.major).toBeNull();
    expect(diag.satisfiesMinimum).toBe(false);
  });

  it("handles system install path", () => {
    const details = makeRuntimeDetails({
      version: "24.14.0",
      execPath: "/usr/local/bin/node",
    });
    const diag = collectNodeRuntimeDiagnostics({ runtimeDetails: details });
    expect(diag.versionManaged).toBe(false);
    expect(diag.versionManagerHint).toBeNull();
  });
});

// ─── buildNodeRuntimeWarnings ───────────────────────────────────

describe("buildNodeRuntimeWarnings", () => {
  it("returns empty array for recommended version", () => {
    const diag = makeDiag({ version: "24.14.0", major: 24 });
    expect(buildNodeRuntimeWarnings(diag)).toEqual([]);
  });

  it("warns when Node version is below minimum", () => {
    const diag = makeDiag({
      version: "20.0.0",
      major: 20,
      satisfiesMinimum: false,
    });
    const warnings = buildNodeRuntimeWarnings(diag);
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("does not meet the minimum");
    expect(warnings[1]).toContain("nodejs.org");
  });

  it("warns when Node version is past EOL", () => {
    const diag = makeDiag({ version: "22.14.0", major: 22 });
    // Simulate a date after Node 22 EOL (2027-04-30)
    const futureDate = new Date("2027-06-01");
    const warnings = buildNodeRuntimeWarnings(diag, futureDate);
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("end-of-life");
    expect(warnings[1]).toContain("Upgrade to Node 24");
  });

  it("warns when Node version is in maintenance phase", () => {
    const diag = makeDiag({ version: "22.14.0", major: 22 });
    // Simulate a date during Node 22 maintenance (after 2025-10-21, before 2027-04-30)
    const maintenanceDate = new Date("2026-06-01");
    const warnings = buildNodeRuntimeWarnings(diag, maintenanceDate);
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("maintenance mode");
    expect(warnings[0]).toContain("months remaining");
    expect(warnings[1]).toContain("upgrading to Node 24");
  });

  it("nudges upgrade when running older-than-recommended LTS (pre-maintenance)", () => {
    const diag = makeDiag({ version: "22.14.0", major: 22 });
    // Before maintenance starts (2025-10-21)
    const earlyDate = new Date("2025-06-01");
    const warnings = buildNodeRuntimeWarnings(diag, earlyDate);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Node 24 is recommended");
  });

  it("shows no warnings for current recommended version", () => {
    const diag = makeDiag({ version: "24.14.0", major: 24 });
    const warnings = buildNodeRuntimeWarnings(diag, new Date("2026-04-02"));
    expect(warnings).toEqual([]);
  });

  it("handles null major version gracefully", () => {
    const diag = makeDiag({ version: "unknown", major: null, satisfiesMinimum: true });
    const warnings = buildNodeRuntimeWarnings(diag);
    expect(warnings).toEqual([]);
  });

  it("handles future Node major with no schedule entry", () => {
    const diag = makeDiag({ version: "26.0.0", major: 26 });
    const warnings = buildNodeRuntimeWarnings(diag);
    // No schedule entry for Node 26, and 26 >= RECOMMENDED_NODE_MAJOR (24)
    expect(warnings).toEqual([]);
  });

  it("does not label unknown non-LTS majors as supported (e.g. Node 23)", () => {
    const diag = makeDiag({ version: "23.0.0", major: 23 });
    const warnings = buildNodeRuntimeWarnings(diag, new Date("2025-06-01"));
    // Node 23 is not in NODE_RELEASE_SCHEDULE and is not an LTS line,
    // so Doctor should not emit "Node 23 is supported" nudge.
    expect(warnings).toEqual([]);
  });
});

// ─── buildNodeRuntimeSummary ────────────────────────────────────

describe("buildNodeRuntimeSummary", () => {
  it("formats basic system install summary", () => {
    const diag = makeDiag({
      version: "24.14.0",
      execPath: "/usr/local/bin/node",
      versionManaged: false,
      versionManagerHint: null,
    });
    const summary = buildNodeRuntimeSummary(diag);
    expect(summary).toContain("Node 24.14.0");
    expect(summary).toContain("/usr/local/bin/node");
    expect(summary).toContain("system install");
  });

  it("formats version manager summary with name", () => {
    const diag = makeDiag({
      version: "24.14.0",
      execPath: "/home/user/.nvm/versions/node/v24.14.0/bin/node",
      versionManaged: true,
      versionManagerHint: "nvm",
    });
    const summary = buildNodeRuntimeSummary(diag);
    expect(summary).toContain("Node 24.14.0");
    expect(summary).toContain("via nvm");
  });

  it("formats version managed but unknown manager", () => {
    const diag = makeDiag({
      version: "24.14.0",
      execPath: "/some/custom/manager/bin/node",
      versionManaged: true,
      versionManagerHint: null,
    });
    const summary = buildNodeRuntimeSummary(diag);
    expect(summary).toContain("via version manager");
  });

  it("handles null version", () => {
    const diag = makeDiag({ version: null, execPath: null });
    const summary = buildNodeRuntimeSummary(diag);
    expect(summary).toContain("Node unknown");
  });

  it("uses dot separator between parts", () => {
    const diag = makeDiag({
      version: "24.14.0",
      execPath: "/usr/bin/node",
      versionManagerHint: null,
      versionManaged: false,
    });
    const summary = buildNodeRuntimeSummary(diag);
    // Should have exactly 2 " · " separators (3 parts)
    const separatorCount = (summary.match(/ · /g) || []).length;
    expect(separatorCount).toBe(2);
  });

  it("does not shorten path when home dir is a prefix of sibling directory", () => {
    // Regression test for P1: HOME=/home/alice must not match /home/alice2/...
    const diag = makeDiag({
      version: "24.14.0",
      execPath: "/home/alice2/.nvm/versions/node/v24.14.0/bin/node",
      versionManaged: true,
      versionManagerHint: "nvm",
    });
    // Temporarily override HOME for this test
    const originalHome = process.env.HOME;
    process.env.HOME = "/home/alice";
    try {
      const summary = buildNodeRuntimeSummary(diag);
      // Path should NOT be shortened — /home/alice2 is not under /home/alice
      expect(summary).toContain("/home/alice2/.nvm/versions/node/v24.14.0/bin/node");
      expect(summary).not.toContain("~2/");
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
