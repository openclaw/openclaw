import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let readdirSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, "existsSync");
    readdirSyncSpy = vi.spyOn(fs, "readdirSync");
    // Default: files don't exist
    existsSyncSpy.mockReturnValue(false);
    readdirSyncSpy.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes with empty defaults when no custom requiredReads provided", () => {
    // With empty DEFAULT_REQUIRED_READS, no files are required
    const result = auditPostCompactionReads([], workspaceDir);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("passes when all custom required files are read", () => {
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      return p === path.resolve(workspaceDir, "WORKFLOW_AUTO.md");
    });
    readdirSyncSpy.mockImplementation((dir: unknown, _opts?: unknown) => {
      if (dir === workspaceDir) {
        return [
          { name: "memory", isFile: () => false, isDirectory: () => true },
          { name: "WORKFLOW_AUTO.md", isFile: () => true, isDirectory: () => false },
        ];
      }
      if (String(dir).endsWith("memory")) {
        return [{ name: "2026-02-16.md", isFile: () => true, isDirectory: () => false }];
      }
      return [];
    });

    const readPaths = ["WORKFLOW_AUTO.md", "memory/2026-02-16.md"];
    const customRequired: Array<string | RegExp> = [
      "WORKFLOW_AUTO.md",
      /memory\/\d{4}-\d{2}-\d{2}\.md/,
    ];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("fails when custom required files exist but are not read", () => {
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      return p === path.resolve(workspaceDir, "WORKFLOW_AUTO.md");
    });
    readdirSyncSpy.mockReturnValue([]);

    const customRequired = ["WORKFLOW_AUTO.md"];
    const result = auditPostCompactionReads([], workspaceDir, customRequired);

    expect(result.passed).toBe(false);
    expect(result.missingPatterns).toContain("WORKFLOW_AUTO.md");
    expect(result.missingPatterns).toHaveLength(1);
  });

  it("skips custom required files that don't exist on disk", () => {
    existsSyncSpy.mockReturnValue(false);
    readdirSyncSpy.mockReturnValue([]);

    const customRequired = ["WORKFLOW_AUTO.md"];
    const result = auditPostCompactionReads([], workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("matches RegExp patterns against relative paths when files exist", () => {
    existsSyncSpy.mockReturnValue(false);
    readdirSyncSpy.mockImplementation((dir: unknown, _opts?: unknown) => {
      if (dir === workspaceDir) {
        return [{ name: "memory", isFile: () => false, isDirectory: () => true }];
      }
      if (String(dir).endsWith("memory")) {
        return [{ name: "2026-02-16.md", isFile: () => true, isDirectory: () => false }];
      }
      return [];
    });

    const readPaths = ["memory/2026-02-16.md"];
    const customRequired: Array<string | RegExp> = [/memory\/\d{4}-\d{2}-\d{2}\.md/];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("fails for regex pattern when matching files exist but weren't read", () => {
    existsSyncSpy.mockReturnValue(false);
    readdirSyncSpy.mockImplementation((dir: unknown, _opts?: unknown) => {
      if (dir === workspaceDir) {
        return [{ name: "memory", isFile: () => false, isDirectory: () => true }];
      }
      if (String(dir).endsWith("memory")) {
        return [{ name: "2026-02-16.md", isFile: () => true, isDirectory: () => false }];
      }
      return [];
    });

    const customRequired: Array<string | RegExp> = [/memory\/\d{4}-\d{2}-\d{2}\.md/];
    const result = auditPostCompactionReads([], workspaceDir, customRequired);

    expect(result.passed).toBe(false);
    expect(result.missingPatterns.some((p) => p.includes("memory"))).toBe(true);
  });

  it("normalizes relative paths when matching", () => {
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      return p === path.resolve(workspaceDir, "WORKFLOW_AUTO.md");
    });
    readdirSyncSpy.mockImplementation((dir: unknown, _opts?: unknown) => {
      if (dir === workspaceDir) {
        return [{ name: "memory", isFile: () => false, isDirectory: () => true }];
      }
      if (String(dir).endsWith("memory")) {
        return [{ name: "2026-02-16.md", isFile: () => true, isDirectory: () => false }];
      }
      return [];
    });

    const readPaths = ["./WORKFLOW_AUTO.md", "memory/2026-02-16.md"];
    const customRequired: Array<string | RegExp> = [
      "WORKFLOW_AUTO.md",
      /memory\/\d{4}-\d{2}-\d{2}\.md/,
    ];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("normalizes absolute paths when matching", () => {
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      return p === path.resolve(workspaceDir, "WORKFLOW_AUTO.md");
    });
    readdirSyncSpy.mockImplementation((dir: unknown, _opts?: unknown) => {
      if (dir === workspaceDir) {
        return [{ name: "memory", isFile: () => false, isDirectory: () => true }];
      }
      if (String(dir).endsWith("memory")) {
        return [{ name: "2026-02-16.md", isFile: () => true, isDirectory: () => false }];
      }
      return [];
    });

    const readPaths = [
      "/Users/test/workspace/WORKFLOW_AUTO.md",
      "/Users/test/workspace/memory/2026-02-16.md",
    ];
    const customRequired: Array<string | RegExp> = [
      "WORKFLOW_AUTO.md",
      /memory\/\d{4}-\d{2}-\d{2}\.md/,
    ];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("accepts custom required reads list", () => {
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      return p === path.resolve(workspaceDir, "custom.md");
    });

    const readPaths = ["custom.md"];
    const customRequired = ["custom.md"];
    const result = auditPostCompactionReads(readPaths, workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("skips custom required file that doesn't exist", () => {
    existsSyncSpy.mockReturnValue(false);

    const customRequired = ["nonexistent.md"];
    const result = auditPostCompactionReads([], workspaceDir, customRequired);

    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toEqual([]);
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
