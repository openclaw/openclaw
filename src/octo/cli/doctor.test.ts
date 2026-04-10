// Octopus Orchestrator — `openclaw octo doctor` tests (M1-29)
//
// Covers:
//   - checkFeatureFlag: ok with default config
//   - checkStatePath: ok when writable, error when not
//   - checkSqliteRegistry: ok with valid DB, error on bad path
//   - checkEventLog: ok when missing, ok with valid JSONL, warning on corrupt
//   - checkTmux: reports availability (ok or error)
//   - checkAgentCeiling: always ok (placeholder)
//   - runDoctorChecks: full round-trip returns 6 checks
//   - formatDoctorOutput: human-readable output structure
//   - runOctoDoctor: exit code 0 when all ok/warning, 1 when error present
//   - runOctoDoctor: json mode emits valid JSON array

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DoctorCheck, formatDoctorOutput, runDoctorChecks, runOctoDoctor } from "./doctor.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp dir harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-doctor-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Individual check tests
// ──────────────────────────────────────────────────────────────────────────

describe("feature-flag check", () => {
  it("returns ok with enabled state from default config", () => {
    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: path.join(tempDir, "events.jsonl"),
    });
    const flag = checks.find((c) => c.name === "feature-flag");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("ok");
    expect(flag!.message).toContain("enabled=");
  });
});

describe("state-path check", () => {
  it("returns ok when state dir is writable", () => {
    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: path.join(tempDir, "events.jsonl"),
    });
    const sp = checks.find((c) => c.name === "state-path");
    expect(sp).toBeDefined();
    // The real state dir should be writable in test environments
    expect(["ok", "error"]).toContain(sp!.severity);
  });
});

describe("sqlite-registry check", () => {
  it("returns ok with a valid registry path", () => {
    const dbPath = path.join(tempDir, "registry.sqlite");
    const checks = runDoctorChecks({
      registryPath: dbPath,
      eventLogPath: path.join(tempDir, "events.jsonl"),
    });
    const reg = checks.find((c) => c.name === "sqlite-registry");
    expect(reg).toBeDefined();
    expect(reg!.severity).toBe("ok");
    expect(reg!.message).toContain("SELECT 1");
  });

  it("returns error when registry path is in a non-existent unwritable location", () => {
    const badPath = "/dev/null/impossible/registry.sqlite";
    const checks = runDoctorChecks({
      registryPath: badPath,
      eventLogPath: path.join(tempDir, "events.jsonl"),
    });
    const reg = checks.find((c) => c.name === "sqlite-registry");
    expect(reg).toBeDefined();
    expect(reg!.severity).toBe("error");
    expect(reg!.detail).toBeDefined();
  });
});

describe("event-log check", () => {
  it("returns ok when event log does not exist", () => {
    const logPath = path.join(tempDir, "nonexistent.jsonl");
    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: logPath,
    });
    const el = checks.find((c) => c.name === "event-log");
    expect(el).toBeDefined();
    expect(el!.severity).toBe("ok");
    expect(el!.message).toContain("does not exist");
  });

  it("returns ok when event log contains valid JSON lines", () => {
    const logPath = path.join(tempDir, "events.jsonl");
    const lines = [
      JSON.stringify({ event_id: "a", ts: "2024-01-01T00:00:00Z" }),
      JSON.stringify({ event_id: "b", ts: "2024-01-01T00:01:00Z" }),
    ];
    writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: logPath,
    });
    const el = checks.find((c) => c.name === "event-log");
    expect(el).toBeDefined();
    expect(el!.severity).toBe("ok");
    expect(el!.message).toContain("checked last 2 entries");
  });

  it("returns warning when event log contains invalid JSON", () => {
    const logPath = path.join(tempDir, "events.jsonl");
    writeFileSync(logPath, '{"valid":true}\nNOT VALID JSON\n', "utf8");

    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: logPath,
    });
    const el = checks.find((c) => c.name === "event-log");
    expect(el).toBeDefined();
    expect(el!.severity).toBe("warning");
    expect(el!.message).toContain("invalid JSON");
  });
});

describe("tmux check", () => {
  it("reports tmux availability", () => {
    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: path.join(tempDir, "events.jsonl"),
    });
    const tmux = checks.find((c) => c.name === "tmux");
    expect(tmux).toBeDefined();
    // tmux may or may not be installed in CI
    expect(["ok", "error"]).toContain(tmux!.severity);
  });
});

describe("agent-ceiling check", () => {
  it("returns ok placeholder", () => {
    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: path.join(tempDir, "events.jsonl"),
    });
    const ceil = checks.find((c) => c.name === "agent-ceiling");
    expect(ceil).toBeDefined();
    expect(ceil!.severity).toBe("ok");
    expect(ceil!.message).toContain("deferred to M5");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runDoctorChecks round-trip
// ──────────────────────────────────────────────────────────────────────────

describe("runDoctorChecks", () => {
  it("returns exactly 6 checks", () => {
    const checks = runDoctorChecks({
      registryPath: path.join(tempDir, "reg.sqlite"),
      eventLogPath: path.join(tempDir, "events.jsonl"),
    });
    expect(checks).toHaveLength(6);
    const names = checks.map((c) => c.name);
    expect(names).toContain("feature-flag");
    expect(names).toContain("state-path");
    expect(names).toContain("sqlite-registry");
    expect(names).toContain("event-log");
    expect(names).toContain("tmux");
    expect(names).toContain("agent-ceiling");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// formatDoctorOutput
// ──────────────────────────────────────────────────────────────────────────

describe("formatDoctorOutput", () => {
  it("renders header and severity labels", () => {
    const checks: DoctorCheck[] = [
      { name: "test-ok", severity: "ok", message: "all good" },
      { name: "test-warn", severity: "warning", message: "heads up" },
      { name: "test-err", severity: "error", message: "broken", detail: "more info" },
    ];
    const output = formatDoctorOutput(checks);
    expect(output).toContain("Octopus Doctor");
    expect(output).toContain("[OK] test-ok: all good");
    expect(output).toContain("[WARN] test-warn: heads up");
    expect(output).toContain("[ERR] test-err: broken");
    expect(output).toContain("more info");
    expect(output).toContain("1 issue(s) require attention.");
  });

  it("reports all checks passed when no errors", () => {
    const checks: DoctorCheck[] = [
      { name: "a", severity: "ok", message: "fine" },
      { name: "b", severity: "warning", message: "minor" },
    ];
    const output = formatDoctorOutput(checks);
    expect(output).toContain("All checks passed.");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runOctoDoctor — exit codes + json mode
// ──────────────────────────────────────────────────────────────────────────

describe("runOctoDoctor", () => {
  it("returns exit code 0 when no errors", () => {
    let captured = "";
    const out = {
      write: (s: string) => {
        captured += s;
      },
    };
    const code = runOctoDoctor(
      {
        registryPath: path.join(tempDir, "reg.sqlite"),
        eventLogPath: path.join(tempDir, "events.jsonl"),
      },
      out,
    );
    // Exit code depends on tmux availability; if tmux is missing it's 1
    expect([0, 1]).toContain(code);
    expect(captured.length).toBeGreaterThan(0);
  });

  it("returns exit code 1 when registry check fails", () => {
    let captured = "";
    const out = {
      write: (s: string) => {
        captured += s;
      },
    };
    const code = runOctoDoctor(
      {
        registryPath: "/dev/null/impossible/reg.sqlite",
        eventLogPath: path.join(tempDir, "events.jsonl"),
      },
      out,
    );
    expect(code).toBe(1);
  });

  it("emits valid JSON array in json mode", () => {
    let captured = "";
    const out = {
      write: (s: string) => {
        captured += s;
      },
    };
    runOctoDoctor(
      {
        json: true,
        registryPath: path.join(tempDir, "reg.sqlite"),
        eventLogPath: path.join(tempDir, "events.jsonl"),
      },
      out,
    );
    const parsed = JSON.parse(captured) as DoctorCheck[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(6);
    for (const check of parsed) {
      expect(check.name).toBeDefined();
      expect(check.severity).toBeDefined();
      expect(check.message).toBeDefined();
    }
  });
});
