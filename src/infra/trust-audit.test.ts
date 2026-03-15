import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  appendTrustAuditEntry,
  cleanupTrustAudit,
  formatTrustAuditCommand,
  loadTrustAudit,
  resolveTrustAuditPath,
  summarizeTrustAudit,
  tryAppendTrustAuditEntry,
} from "./trust-audit.js";

describe("trust audit", () => {
  let previousHome: string | undefined;
  let homeDir = "";

  beforeEach(() => {
    previousHome = process.env.OPENCLAW_HOME;
    homeDir = makeTempDir();
    process.env.OPENCLAW_HOME = homeDir;
  });

  afterEach(() => {
    process.env.OPENCLAW_HOME = previousHome;
  });

  it("writes and loads audit entries", () => {
    const entry = appendTrustAuditEntry({
      agentId: "main",
      command: "echo hello",
      exitCode: 0,
      durationMs: 25,
      now: 1_000,
    });
    expect(entry).toEqual({
      ts: 1_000,
      cmd: "echo hello",
      code: 0,
      durationMs: 25,
    });
    const loaded = loadTrustAudit({ agentId: "main" });
    expect(loaded.exists).toBe(true);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.cmd).toBe("echo hello");
  });

  it("formats commands with whitespace normalization and truncation", () => {
    expect(formatTrustAuditCommand("echo   hello\nworld")).toBe("echo hello world");
    const long = formatTrustAuditCommand("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns null for empty or whitespace-only commands", () => {
    expect(appendTrustAuditEntry({ agentId: "main", command: "" })).toBeNull();
    expect(appendTrustAuditEntry({ agentId: "main", command: "   " })).toBeNull();
  });

  it("summarizes entries within provided window", () => {
    appendTrustAuditEntry({ agentId: "main", command: "cmd-1", exitCode: 0, now: 1_000 });
    appendTrustAuditEntry({ agentId: "main", command: "cmd-2", exitCode: 2, now: 2_000 });
    appendTrustAuditEntry({ agentId: "main", command: "cmd-3", exitCode: 0, now: 80_000 });

    const summary = summarizeTrustAudit({
      agentId: "main",
      startedAt: 500,
      endedAt: 10_000,
    });

    expect(summary).toContain("Commands: 2 (1 failed)");
    expect(summary).toContain("- cmd-1");
    expect(summary).toContain("- cmd-2");
    expect(summary).not.toContain("cmd-3");
  });

  it("returns null when no audit entries exist in window", () => {
    const summary = summarizeTrustAudit({ agentId: "main" });
    expect(summary).toBeNull();
  });

  it("formats duration in hours for long trust windows", () => {
    appendTrustAuditEntry({ agentId: "main", command: "cmd", exitCode: 0, now: 0 });
    const summary = summarizeTrustAudit({ agentId: "main", startedAt: 0, endedAt: 90 * 60_000 });
    expect(summary).toContain("1h 30m");
  });

  it("shows all commands when 10 or fewer entries", () => {
    for (let i = 0; i < 10; i++) {
      appendTrustAuditEntry({ agentId: "main", command: `cmd-${i}`, exitCode: 0, now: 1_000 + i });
    }
    const summary = summarizeTrustAudit({ agentId: "main" });
    expect(summary).toBeDefined();
    for (let i = 0; i < 10; i++) {
      expect(summary).toContain(`cmd-${i}`);
    }
    expect(summary).not.toContain("more");
  });

  it("truncates command list when more than 10 entries", () => {
    for (let i = 0; i < 11; i++) {
      appendTrustAuditEntry({ agentId: "main", command: `cmd-${i}`, exitCode: 0, now: 1_000 + i });
    }
    const summary = summarizeTrustAudit({ agentId: "main" });
    expect(summary).toBeDefined();
    expect(summary).toContain("cmd-0");
    expect(summary).toContain("cmd-4");
    expect(summary).toContain("6 more");
  });

  it("cleans up the audit file", () => {
    appendTrustAuditEntry({ agentId: "main", command: "echo hi", now: 100 });
    const filePath = resolveTrustAuditPath("main");
    expect(fs.existsSync(filePath)).toBe(true);
    cleanupTrustAudit("main");
    expect(fs.existsSync(filePath)).toBe(false);
    expect(path.dirname(filePath)).toContain(path.resolve(homeDir));
  });

  it("cleanupTrustAudit is a no-op when file does not exist", () => {
    expect(() => cleanupTrustAudit("nonexistent-agent")).not.toThrow();
  });

  it("skips malformed JSONL lines during load", () => {
    const auditPath = resolveTrustAuditPath("main");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.writeFileSync(
      auditPath,
      [
        JSON.stringify({ ts: 1000, cmd: "echo ok", code: 0, durationMs: null }),
        "not-valid-json{{",
        JSON.stringify({ ts: 2000, cmd: "echo ok2", code: 0, durationMs: null }),
      ].join("\n"),
    );
    const { entries, exists } = loadTrustAudit({ agentId: "main" });
    expect(exists).toBe(true);
    expect(entries).toHaveLength(2);
  });

  it("tryAppendTrustAuditEntry does not throw when audit write fails", () => {
    // Point audit path at a directory to force a write error.
    const dirPath = resolveTrustAuditPath("main");
    fs.mkdirSync(dirPath, { recursive: true });
    expect(() =>
      tryAppendTrustAuditEntry({
        agentId: "main",
        command: "echo hi",
        exitCode: 0,
        logLabel: "test",
      }),
    ).not.toThrow();
  });
});
