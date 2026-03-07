import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildContextDigestAnchorPrompt,
  extractOpenItemsSection,
} from "./context-digest-anchor.js";

let suiteWorkspaceRoot = "";

beforeAll(async () => {
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-anchor-"));
});

afterAll(async () => {
  if (suiteWorkspaceRoot) {
    await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  }
});

describe("extractOpenItemsSection", () => {
  it("should extract Open Items section content", () => {
    const content = `# Context Digest
Last updated: 2026-03-04T10:00:00Z

## Topics Discussed
- Topic 1

## Key Decisions
- Decision 1

## Open Items / Action Items
- [ ] Complete API v3 migration
- [ ] Review PR #33842
- [ ] Benchmark memory search

## Important Context
- Background info
`;
    const result = extractOpenItemsSection(content);
    expect(result).toBe(
      "- [ ] Complete API v3 migration\n- [ ] Review PR #33842\n- [ ] Benchmark memory search",
    );
  });

  it("should return null when section is missing", () => {
    const content = `# Context Digest
## Topics Discussed
- Topic 1
`;
    expect(extractOpenItemsSection(content)).toBeNull();
  });

  it("should return null when section contains only placeholder text", () => {
    const content = `## Open Items / Action Items

*None*

## Important Context
`;
    expect(extractOpenItemsSection(content)).toBeNull();
  });

  it("should return null for no-LLM placeholder", () => {
    const content = `## Open Items / Action Items

*No LLM analysis available.*

## Important Context
`;
    expect(extractOpenItemsSection(content)).toBeNull();
  });

  it("should handle Open Items as the last section", () => {
    const content = `## Key Decisions
- Decision 1

## Open Items / Action Items
- [ ] Task 1
- [ ] Task 2
`;
    const result = extractOpenItemsSection(content);
    expect(result).toBe("- [ ] Task 1\n- [ ] Task 2");
  });
});

describe("buildContextDigestAnchorPrompt", () => {
  it("should return undefined when digest file does not exist", async () => {
    const workDir = path.join(suiteWorkspaceRoot, "no-file");
    await fs.mkdir(workDir, { recursive: true });

    const result = await buildContextDigestAnchorPrompt({ workspaceDir: workDir });
    expect(result).toBeUndefined();
  });

  it("should return undefined when Open Items section is empty", async () => {
    const workDir = path.join(suiteWorkspaceRoot, "empty-items");
    const memoryDir = path.join(workDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "context-digest.md"),
      `# Context Digest
## Open Items / Action Items

*None*
`,
      "utf-8",
    );

    const result = await buildContextDigestAnchorPrompt({ workspaceDir: workDir });
    expect(result).toBeUndefined();
  });

  it("should return anchor prompt with Open Items content", async () => {
    const workDir = path.join(suiteWorkspaceRoot, "with-items");
    const memoryDir = path.join(workDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "context-digest.md"),
      `# Context Digest
## Open Items / Action Items
- [ ] Deploy API v3
- [ ] Update SDK docs

## Important Context
- stuff
`,
      "utf-8",
    );

    const result = await buildContextDigestAnchorPrompt({ workspaceDir: workDir });
    expect(result).toBeDefined();
    expect(result).toContain("open items");
    expect(result).toContain("Deploy API v3");
    expect(result).toContain("Update SDK docs");
  });

  it("should truncate content exceeding maxChars", async () => {
    const workDir = path.join(suiteWorkspaceRoot, "truncate");
    const memoryDir = path.join(workDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const longItems = Array.from(
      { length: 50 },
      (_, i) => `- [ ] Task ${i}: ${"A".repeat(100)}`,
    ).join("\n");
    await fs.writeFile(
      path.join(memoryDir, "context-digest.md"),
      `## Open Items / Action Items\n${longItems}\n## Important Context\n- stuff`,
      "utf-8",
    );

    const result = await buildContextDigestAnchorPrompt({
      workspaceDir: workDir,
      maxChars: 200,
    });
    expect(result).toBeDefined();
    // Should be reasonably short (prefix + 200 chars + "..." marker)
    expect(result!.length).toBeLessThan(400);
    expect(result).toContain("...");
  });

  it("should handle file read errors gracefully", async () => {
    const workDir = "/nonexistent/path/that/does/not/exist";
    const result = await buildContextDigestAnchorPrompt({ workspaceDir: workDir });
    expect(result).toBeUndefined();
  });
});
