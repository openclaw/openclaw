import path from "node:path";
import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_REQUIRED_READS,
  auditPostCompactionReads,
  extractReadPaths,
  formatAuditWarning,
  isPostCompactionAuditEnabled,
  resolveRequiredReads,
} from "./post-compaction-audit.js";

const WORKSPACE = "/workspace";

describe("auditPostCompactionReads", () => {
  it("passes when all required files were read", () => {
    const reads = [
      path.join(WORKSPACE, "WORKFLOW_AUTO.md"),
      path.join(WORKSPACE, "memory/2026-03-04.md"),
    ];
    const result = auditPostCompactionReads(reads, WORKSPACE);
    expect(result.passed).toBe(true);
    expect(result.missingPatterns).toHaveLength(0);
  });

  it("fails when WORKFLOW_AUTO.md was not read", () => {
    const reads = [path.join(WORKSPACE, "memory/2026-03-04.md")];
    const result = auditPostCompactionReads(reads, WORKSPACE);
    expect(result.passed).toBe(false);
    expect(result.missingPatterns).toContain("WORKFLOW_AUTO.md");
  });

  it("fails when no daily memory file was read", () => {
    const reads = [path.join(WORKSPACE, "WORKFLOW_AUTO.md")];
    const result = auditPostCompactionReads(reads, WORKSPACE);
    expect(result.passed).toBe(false);
    expect(result.missingPatterns).toContain("memory\\/\\d{4}-\\d{2}-\\d{2}\\.md");
  });

  it("passes with custom required reads", () => {
    const reads = [path.join(WORKSPACE, "SOUL.md")];
    const result = auditPostCompactionReads(reads, WORKSPACE, ["SOUL.md"]);
    expect(result.passed).toBe(true);
  });

  it("fails with custom required reads when file missing", () => {
    const reads = [];
    const result = auditPostCompactionReads(reads, WORKSPACE, ["SOUL.md"]);
    expect(result.passed).toBe(false);
    expect(result.missingPatterns).toContain("SOUL.md");
  });
});

describe("resolveRequiredReads", () => {
  it("returns defaults when no config provided", () => {
    const result = resolveRequiredReads();
    expect(result).toEqual(DEFAULT_REQUIRED_READS);
  });

  it("returns defaults when hooks.postCompactionAudit.requiredReads is empty", () => {
    const cfg = {
      hooks: { postCompactionAudit: { requiredReads: [] } },
    } as unknown as OpenClawConfig;
    const result = resolveRequiredReads(cfg);
    expect(result).toEqual(DEFAULT_REQUIRED_READS);
  });

  it("returns configured string reads", () => {
    const cfg = {
      hooks: { postCompactionAudit: { requiredReads: ["AGENTS.md", "SOUL.md"] } },
    } as unknown as OpenClawConfig;
    const result = resolveRequiredReads(cfg);
    expect(result).toEqual(["AGENTS.md", "SOUL.md"]);
  });

  it("converts slash-wrapped entries to RegExp", () => {
    const cfg = {
      hooks: { postCompactionAudit: { requiredReads: ["/memory\\/\\d{4}-\\d{2}-\\d{2}\\.md/"] } },
    } as unknown as OpenClawConfig;
    const result = resolveRequiredReads(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(RegExp);
    expect((result[0] as RegExp).test("memory/2026-03-04.md")).toBe(true);
  });
});

describe("isPostCompactionAuditEnabled", () => {
  it("defaults to true when no config provided", () => {
    expect(isPostCompactionAuditEnabled()).toBe(true);
  });

  it("returns true when enabled is not set", () => {
    const cfg = { hooks: { postCompactionAudit: {} } } as unknown as OpenClawConfig;
    expect(isPostCompactionAuditEnabled(cfg)).toBe(true);
  });

  it("returns false when explicitly disabled", () => {
    const cfg = {
      hooks: { postCompactionAudit: { enabled: false } },
    } as unknown as OpenClawConfig;
    expect(isPostCompactionAuditEnabled(cfg)).toBe(false);
  });

  it("returns true when explicitly enabled", () => {
    const cfg = {
      hooks: { postCompactionAudit: { enabled: true } },
    } as unknown as OpenClawConfig;
    expect(isPostCompactionAuditEnabled(cfg)).toBe(true);
  });
});

describe("extractReadPaths", () => {
  it("extracts paths from read tool calls", () => {
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
    ];
    expect(extractReadPaths(messages)).toEqual(["WORKFLOW_AUTO.md"]);
  });

  it("supports path alias", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "read",
            input: { path: "memory/2026-03-04.md" },
          },
        ],
      },
    ];
    expect(extractReadPaths(messages)).toEqual(["memory/2026-03-04.md"]);
  });

  it("ignores non-read tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "write",
            input: { file_path: "output.txt" },
          },
        ],
      },
    ];
    expect(extractReadPaths(messages)).toEqual([]);
  });
});

describe("formatAuditWarning", () => {
  it("formats a warning with missing patterns", () => {
    const result = formatAuditWarning(["WORKFLOW_AUTO.md", "memory/\\d+.md"]);
    expect(result).toContain("Post-Compaction Audit");
    expect(result).toContain("WORKFLOW_AUTO.md");
    expect(result).toContain("memory/\\d+.md");
  });
});
