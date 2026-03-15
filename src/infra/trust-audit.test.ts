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

  it("cleans up the audit file", () => {
    appendTrustAuditEntry({ agentId: "main", command: "echo hi", now: 100 });
    const filePath = resolveTrustAuditPath("main");
    expect(fs.existsSync(filePath)).toBe(true);
    cleanupTrustAudit("main");
    expect(fs.existsSync(filePath)).toBe(false);
    expect(path.dirname(filePath)).toContain(path.resolve(homeDir));
  });
});
