import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  auditPostCompactionReads,
  extractReadPaths,
  formatAuditWarning,
} from "./post-compaction-audit.js";

describe("extractReadPaths", () => {
  it("extracts file paths from Read tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { file_path: "WORKFLOW_AUTO.md" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { file_path: "memory/2026-02-16.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual(["WORKFLOW_AUTO.md", "memory/2026-02-16.md"]);
  });

  it("handles path parameter (alternative to file_path)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { path: "AGENTS.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual(["AGENTS.md"]);
  });

  it("ignores non-assistant messages", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { file_path: "should_be_ignored.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual([]);
  });

  it("ignores non-read tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "exec",
            input: { command: "cat WORKFLOW_AUTO.md" },
          },
        ],
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual([]);
  });

  it("handles empty messages array", () => {
    const paths = extractReadPaths([]);
    expect(paths).toEqual([]);
  });

  it("handles messages with non-array content", () => {
    const messages = [
      {
        role: "assistant",
        content: "text only",
      },
    ];

    const paths = extractReadPaths(messages);
    expect(paths).toEqual([]);
  });
});

describe("auditPostCompactionReads", () => {
  const workspaceDir = "/Users/test/workspace";

  it("passes when all required files are read (with custom list)", () => {
    // Use custom required reads to avoid fs.existsSync dependency for basic test
    const readPaths = ["custom.md", "memory/2026-02-16.md"];
    const customRequired: Array<string | RegExp> = [/memory\/\d{4}-\d{2}-\d{2}\.md/];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("fails when no files are read (regex pattern)", () => {
    const result = auditPostCompactionReads([], workspaceDir);

    expect(result.passed).toBe(false);
    // Default required reads now only contain the memory regex pattern
    expect(result.missingPatterns.some((p) => p.includes("memory"))).toBe(true);
  });

  it("does not require WORKFLOW_AUTO.md by default", () => {
    // WORKFLOW_AUTO.md was removed from DEFAULT_REQUIRED_READS (#22674)
    const readPaths = ["memory/2026-02-16.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).not.toContain("WORKFLOW_AUTO.md");
  });

  it("skips string entries that do not exist on disk", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("exists.md");
    });

    const readPaths: string[] = [];
    const customRequired = ["exists.md", "missing.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    // Only exists.md should be enforced — missing.md should be skipped
    expect(result.passed).toBe(false);
    expect(result.missingPatterns).toEqual(["exists.md"]);
    expect(result.missingPatterns).not.toContain("missing.md");

    existsSyncSpy.mockRestore();
  });

  it("matches RegExp patterns against relative paths", () => {
    const readPaths = ["memory/2026-02-16.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("normalizes absolute paths when matching", () => {
    const readPaths = ["/Users/test/workspace/memory/2026-02-16.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("accepts custom required reads list with existing files", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const readPaths = ["custom.md"];
    const customRequired = ["custom.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);

    existsSyncSpy.mockRestore();
  });

  it("passes when all string required-reads are absent from disk", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    // Only string entries, all missing from disk → nothing to enforce → passes
    const readPaths: string[] = [];
    const customRequired = ["WORKFLOW_AUTO.md", "NONEXISTENT.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);

    existsSyncSpy.mockRestore();
  });
});

describe("formatAuditWarning", () => {
  it("formats warning message with missing patterns", () => {
    const missingPatterns = ["WORKFLOW_AUTO.md", "memory\\/\\d{4}-\\d{2}-\\d{2}\\.md"];
    const message = formatAuditWarning(missingPatterns);

    expect(message).toContain("⚠️ Post-Compaction Audit");
    expect(message).toContain("WORKFLOW_AUTO.md");
    expect(message).toContain("memory");
    expect(message).toContain("Please read them now");
  });

  it("formats single missing pattern", () => {
    const missingPatterns = ["WORKFLOW_AUTO.md"];
    const message = formatAuditWarning(missingPatterns);

    expect(message).toContain("WORKFLOW_AUTO.md");
    // Check that the missing patterns list only contains WORKFLOW_AUTO.md
    const lines = message.split("\n");
    const patternLines = lines.filter((l) => l.trim().startsWith("- "));
    expect(patternLines).toHaveLength(1);
    expect(patternLines[0]).toContain("WORKFLOW_AUTO.md");
  });
});
