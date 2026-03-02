import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock expandHomePrefix to redirect to a temp dir
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trust-audit-"));

vi.mock("./home-dir.js", () => ({
  expandHomePrefix: (p: string) => p.replace("~/.openclaw/", `${tmpBase}/`),
}));

const {
  appendTrustAuditEntry,
  cleanupTrustAudit,
  formatTrustAuditCommand,
  loadTrustAudit,
  resolveTrustAuditPath,
  summarizeTrustAudit,
} = await import("./trust-audit.js");

afterEach(() => {
  // Clean up any audit files between tests
  for (const f of fs.readdirSync(tmpBase)) {
    if (f.startsWith("trust-audit-")) {
      fs.unlinkSync(path.join(tmpBase, f));
    }
  }
});

describe("trust-audit", () => {
  describe("resolveTrustAuditPath", () => {
    it("uses agent id in filename", () => {
      expect(resolveTrustAuditPath("myagent")).toContain("trust-audit-myagent.jsonl");
    });

    it("defaults to main agent when no id provided", () => {
      expect(resolveTrustAuditPath()).toContain("trust-audit-main.jsonl");
    });

    it("trims whitespace from agent id", () => {
      expect(resolveTrustAuditPath("  foo  ")).toContain("trust-audit-foo.jsonl");
    });
  });

  describe("formatTrustAuditCommand", () => {
    it("normalizes whitespace", () => {
      expect(formatTrustAuditCommand("echo   hello\n  world")).toBe("echo hello world");
    });

    it("truncates long commands", () => {
      const long = "x".repeat(300);
      const result = formatTrustAuditCommand(long);
      expect(result.length).toBeLessThanOrEqual(200);
      expect(result.endsWith("…")).toBe(true);
    });

    it("preserves short commands", () => {
      expect(formatTrustAuditCommand("ls -la")).toBe("ls -la");
    });
  });

  describe("appendTrustAuditEntry", () => {
    it("appends entry to JSONL file", () => {
      const entry = appendTrustAuditEntry({
        agentId: "test1",
        command: "echo hello",
        exitCode: 0,
        durationMs: 100,
        now: 1000,
      });
      expect(entry).toEqual({ ts: 1000, cmd: "echo hello", code: 0, durationMs: 100 });

      const { entries } = loadTrustAudit({ agentId: "test1" });
      expect(entries).toHaveLength(1);
      expect(entries[0].cmd).toBe("echo hello");
    });

    it("appends multiple entries", () => {
      appendTrustAuditEntry({ agentId: "test2", command: "cmd1", now: 1000 });
      appendTrustAuditEntry({ agentId: "test2", command: "cmd2", now: 2000 });
      appendTrustAuditEntry({ agentId: "test2", command: "cmd3", now: 3000 });

      const { entries } = loadTrustAudit({ agentId: "test2" });
      expect(entries).toHaveLength(3);
    });

    it("returns null for empty command", () => {
      expect(appendTrustAuditEntry({ command: "   " })).toBeNull();
    });

    it("handles null exit code", () => {
      const entry = appendTrustAuditEntry({ agentId: "test3", command: "kill -9", now: 1000 });
      expect(entry?.code).toBeNull();
    });
  });

  describe("loadTrustAudit", () => {
    it("returns exists=false when no file", () => {
      const result = loadTrustAudit({ agentId: "nonexistent" });
      expect(result).toEqual({ entries: [], exists: false });
    });

    it("skips malformed JSON lines", () => {
      const filePath = resolveTrustAuditPath("corrupt");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        [
          JSON.stringify({ ts: 1000, cmd: "good", code: 0, durationMs: 10 }),
          "NOT VALID JSON",
          JSON.stringify({ ts: 2000, cmd: "also good", code: 0, durationMs: 20 }),
        ].join("\n") + "\n",
      );

      const { entries, exists } = loadTrustAudit({ agentId: "corrupt" });
      expect(exists).toBe(true);
      expect(entries).toHaveLength(2);
      expect(entries[0].cmd).toBe("good");
      expect(entries[1].cmd).toBe("also good");
    });

    it("skips entries missing required fields", () => {
      const filePath = resolveTrustAuditPath("badfields");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        [
          JSON.stringify({ ts: 1000, cmd: "ok", code: 0 }),
          JSON.stringify({ ts: "not a number", cmd: "bad" }),
          JSON.stringify({ ts: 2000 }), // missing cmd
        ].join("\n") + "\n",
      );

      const { entries } = loadTrustAudit({ agentId: "badfields" });
      expect(entries).toHaveLength(1);
      expect(entries[0].cmd).toBe("ok");
    });

    it("handles empty file", () => {
      const filePath = resolveTrustAuditPath("empty");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "");

      const { entries, exists } = loadTrustAudit({ agentId: "empty" });
      expect(exists).toBe(true);
      expect(entries).toHaveLength(0);
    });
  });

  describe("summarizeTrustAudit", () => {
    it("summarizes when no audit file exists", () => {
      const result = summarizeTrustAudit({ agentId: "nope", startedAt: 1000, endedAt: 61_000 });
      expect(result).toContain("Commands: 0 (0 failed)");
      expect(result).toContain("Duration: 1m");
    });

    it("summarizes with zero commands", () => {
      const filePath = resolveTrustAuditPath("zero");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "");

      const result = summarizeTrustAudit({ agentId: "zero", startedAt: 1000, endedAt: 61_000 });
      expect(result).toContain("Commands: 0 (0 failed)");
      expect(result).toContain("Duration: 1m");
    });

    it("lists commands when ≤10", () => {
      for (let i = 0; i < 5; i++) {
        appendTrustAuditEntry({ agentId: "few", command: `cmd${i}`, exitCode: 0, now: 1000 + i });
      }

      const result = summarizeTrustAudit({ agentId: "few", startedAt: 1000, endedAt: 61_000 })!;
      expect(result).toContain("Commands: 5 (0 failed)");
      expect(result).toContain("- cmd0");
      expect(result).toContain("- cmd4");
      expect(result).not.toContain("more");
    });

    it("truncates command list when >10", () => {
      for (let i = 0; i < 12; i++) {
        appendTrustAuditEntry({ agentId: "many", command: `cmd${i}`, exitCode: 0, now: 1000 + i });
      }

      const result = summarizeTrustAudit({ agentId: "many", startedAt: 1000, endedAt: 61_000 })!;
      expect(result).toContain("Commands: 12 (0 failed)");
      expect(result).toContain("- cmd0");
      expect(result).toContain("- cmd4");
      expect(result).not.toContain("- cmd5");
      expect(result).toContain("…and 7 more");
    });

    it("counts failures", () => {
      appendTrustAuditEntry({ agentId: "fails", command: "ok", exitCode: 0, now: 1000 });
      appendTrustAuditEntry({ agentId: "fails", command: "bad1", exitCode: 1, now: 2000 });
      appendTrustAuditEntry({ agentId: "fails", command: "bad2", exitCode: 127, now: 3000 });

      const result = summarizeTrustAudit({ agentId: "fails", startedAt: 1000, endedAt: 61_000 })!;
      expect(result).toContain("Commands: 3 (2 failed)");
    });

    it("formats hours for long durations", () => {
      const filePath = resolveTrustAuditPath("long");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ ts: 1000, cmd: "x", code: 0 }) + "\n");

      const result = summarizeTrustAudit({
        agentId: "long",
        startedAt: 0,
        endedAt: 90 * 60_000, // 90 minutes
      })!;
      expect(result).toContain("Duration: 1h 30m");
    });
  });

  describe("cleanupTrustAudit", () => {
    it("deletes the audit file", () => {
      appendTrustAuditEntry({ agentId: "cleanup", command: "test", now: 1000 });
      const filePath = resolveTrustAuditPath("cleanup");
      expect(fs.existsSync(filePath)).toBe(true);

      cleanupTrustAudit("cleanup");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("does not throw when file does not exist", () => {
      expect(() => cleanupTrustAudit("nonexistent")).not.toThrow();
    });
  });
});
