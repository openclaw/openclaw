import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILTIN_RULES,
  formatRepairReport,
  runAutoRepair,
  type RepairContext,
  type RepairReport,
  type RepairRule,
} from "./doctor-auto-repair.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-repair-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(overrides?: Partial<RepairContext>): RepairContext {
  return { stateDir: tmpDir, dryRun: false, ...overrides };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("runAutoRepair", () => {
  it("all rules pass on a healthy state directory", () => {
    // Set up healthy state directory
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
    if (process.platform !== "win32") {
      fs.chmodSync(tmpDir, 0o700);
    }

    const report = runAutoRepair(ctx());
    expect(report.passed).toBe(BUILTIN_RULES.length);
    expect(report.repaired).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.actions).toHaveLength(0);
  });

  it("creates missing state directory", () => {
    const missingDir = path.join(tmpDir, "new-state");
    const report = runAutoRepair(ctx({ stateDir: missingDir }));
    expect(report.repaired).toBeGreaterThan(0);
    expect(fs.existsSync(missingDir)).toBe(true);
  });

  it("creates missing sessions and log directories", () => {
    // State dir exists but sub-dirs missing
    if (process.platform !== "win32") {
      fs.chmodSync(tmpDir, 0o700);
    }
    const report = runAutoRepair(ctx());
    expect(fs.existsSync(path.join(tmpDir, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "logs"))).toBe(true);
    expect(report.repaired).toBeGreaterThanOrEqual(2);
  });

  it("repairs corrupted JSON files", () => {
    const configPath = path.join(tmpDir, "openclaw.json");
    fs.writeFileSync(configPath, "BROKEN{{{!!!");
    if (process.platform !== "win32") {
      fs.chmodSync(tmpDir, 0o700);
    }
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });

    const report = runAutoRepair(ctx());
    const jsonAction = report.actions.find((a) => a.ruleId === "corrupted-json-config");
    expect(jsonAction).toBeDefined();
    expect(jsonAction!.repaired).toBe(true);

    // Verify backup was created
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith("openclaw.json.bak."));
    expect(backups.length).toBeGreaterThan(0);

    // Verify file is now valid JSON
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(content).toEqual({});
  });

  it("warns about stale lock files without deleting them", () => {
    const lockPath = path.join(tmpDir, "gateway.lock");
    fs.writeFileSync(lockPath, "locked");
    // Backdate the file to make it stale (2 hours ago)
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(lockPath, new Date(twoHoursAgo), new Date(twoHoursAgo));
    if (process.platform !== "win32") {
      fs.chmodSync(tmpDir, 0o700);
    }
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });

    const report = runAutoRepair(ctx());
    const lockAction = report.actions.find((a) => a.ruleId === "stale-lock-files");
    expect(lockAction).toBeDefined();
    // Safety: should NOT auto-delete, only warn
    expect(lockAction!.repaired).toBe(false);
    expect(lockAction!.detail).toContain("Manual removal recommended");
    // Lock file should still exist
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("does not report fresh lock files", () => {
    const lockPath = path.join(tmpDir, "active.lock");
    fs.writeFileSync(lockPath, "locked");
    // File is fresh (just created) — should NOT be reported
    if (process.platform !== "win32") {
      fs.chmodSync(tmpDir, 0o700);
    }
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });

    const report = runAutoRepair(ctx());
    expect(fs.existsSync(lockPath)).toBe(true);
    const lockAction = report.actions.find((a) => a.ruleId === "stale-lock-files");
    expect(lockAction).toBeUndefined(); // No action needed
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("dry run mode", () => {
  it("does not modify anything in dry run", () => {
    const missingDir = path.join(tmpDir, "dry-state");
    const report = runAutoRepair(ctx({ stateDir: missingDir, dryRun: true }));
    expect(fs.existsSync(missingDir)).toBe(false);
    expect(report.skipped).toBeGreaterThan(0);
    expect(report.repaired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Permissions (unix only)
// ---------------------------------------------------------------------------

if (process.platform !== "win32") {
  describe("permission repairs (unix)", () => {
    it("tightens state directory permissions", () => {
      fs.chmodSync(tmpDir, 0o755); // too open
      fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });

      const report = runAutoRepair(ctx());
      const permAction = report.actions.find((a) => a.ruleId === "state-dir-permissions");
      expect(permAction).toBeDefined();
      expect(permAction!.repaired).toBe(true);

      const stat = fs.statSync(tmpDir);
      expect(stat.mode & 0o777).toBe(0o700);
    });
  });
}

// ---------------------------------------------------------------------------
// Custom rules
// ---------------------------------------------------------------------------

describe("rule dependencies", () => {
  it("skips child rules when parent rule fails", () => {
    const parentRule: RepairRule = {
      id: "parent",
      description: "Always fails",
      severity: "critical",
      check() {
        return { ruleId: "parent", severity: "critical", description: "Parent failed", repaired: false };
      },
    };
    const childRule: RepairRule = {
      id: "child",
      description: "Depends on parent",
      severity: "warning",
      dependsOn: ["parent"],
      check() {
        return undefined; // Would pass if allowed to run
      },
    };
    const report = runAutoRepair(ctx(), [parentRule, childRule]);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(1);
    const childAction = report.actions.find((a) => a.ruleId === "child");
    expect(childAction).toBeDefined();
    expect(childAction!.description).toContain("Skipped");
  });

  it("runs child rules when parent succeeds", () => {
    const parentRule: RepairRule = {
      id: "parent",
      description: "Always passes",
      severity: "critical",
      check() {
        return undefined;
      },
    };
    const childRule: RepairRule = {
      id: "child",
      description: "Depends on parent",
      severity: "warning",
      dependsOn: ["parent"],
      check() {
        return undefined; // Passes
      },
    };
    const report = runAutoRepair(ctx(), [parentRule, childRule]);
    expect(report.passed).toBe(2);
    expect(report.skipped).toBe(0);
  });
});

describe("custom rules", () => {
  it("supports custom rules alongside builtin", () => {
    if (process.platform !== "win32") {
      fs.chmodSync(tmpDir, 0o700);
    }
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });

    const customRule: RepairRule = {
      id: "custom-check",
      description: "Always reports an info action",
      severity: "info",
      check() {
        return {
          ruleId: "custom-check",
          severity: "info",
          description: "Custom rule triggered",
          repaired: true,
        };
      },
    };

    const report = runAutoRepair(ctx(), [...BUILTIN_RULES, customRule]);
    expect(report.actions.some((a) => a.ruleId === "custom-check")).toBe(true);
    expect(report.repaired).toBeGreaterThanOrEqual(1);
  });

  it("handles rules that throw exceptions", () => {
    const badRule: RepairRule = {
      id: "bad-rule",
      description: "Always throws",
      severity: "critical",
      check() {
        throw new Error("Boom");
      },
    };
    const report = runAutoRepair(ctx(), [badRule]);
    expect(report.failed).toBe(1);
    expect(report.actions[0].ruleId).toBe("bad-rule");
  });
});

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe("formatRepairReport", () => {
  it("produces readable output", () => {
    const report: RepairReport = {
      actions: [
        { ruleId: "test", severity: "warning", description: "Something was wrong", repaired: true, detail: "Fixed it" },
      ],
      passed: 3,
      repaired: 1,
      failed: 0,
      skipped: 0,
      durationMs: 42,
    };
    const output = formatRepairReport(report);
    expect(output).toContain("Doctor Auto-Repair");
    expect(output).toContain("Passed: 3");
    expect(output).toContain("Repaired: 1");
    expect(output).toContain("Something was wrong");
    expect(output).toContain("Fixed it");
  });
});
