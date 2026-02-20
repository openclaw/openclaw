import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectBootstrapFiles, readPostCompactionContext } from "./post-compaction-context.js";

describe("detectBootstrapFiles", () => {
  const tmpDir = path.join("/tmp", "test-detect-bootstrap-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no files exist", async () => {
    const result = await detectBootstrapFiles(tmpDir);
    expect(result).toEqual([]);
  });

  it("detects AGENTS.md", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# Agent");
    const result = await detectBootstrapFiles(tmpDir);
    expect(result).toContain("AGENTS.md");
  });

  it("detects multiple bootstrap files", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# Agent");
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "# Soul");
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Memory");
    fs.writeFileSync(path.join(tmpDir, "IDENTITY.md"), "# Identity");
    const result = await detectBootstrapFiles(tmpDir);
    expect(result).toContain("AGENTS.md");
    expect(result).toContain("SOUL.md");
    expect(result).toContain("MEMORY.md");
    expect(result).toContain("IDENTITY.md");
  });

  it("detects daily memory files", async () => {
    const memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "2026-02-17.md"), "notes");
    fs.writeFileSync(path.join(memDir, "2026-02-18.md"), "notes");
    const result = await detectBootstrapFiles(tmpDir);
    expect(result).toContain("memory/2026-02-18.md");
    expect(result).toContain("memory/2026-02-17.md");
  });

  it("limits daily memory files to most recent 2", async () => {
    const memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "2026-02-15.md"), "old");
    fs.writeFileSync(path.join(memDir, "2026-02-16.md"), "older");
    fs.writeFileSync(path.join(memDir, "2026-02-17.md"), "recent");
    fs.writeFileSync(path.join(memDir, "2026-02-18.md"), "today");
    const result = await detectBootstrapFiles(tmpDir);
    expect(result).toContain("memory/2026-02-18.md");
    expect(result).toContain("memory/2026-02-17.md");
    expect(result).not.toContain("memory/2026-02-15.md");
    expect(result).not.toContain("memory/2026-02-16.md");
  });

  it("deduplicates files that share the same inode (case-insensitive FS)", async () => {
    // On case-insensitive filesystems (macOS HFS+/APFS), MEMORY.md and memory.md
    // resolve to the same file/inode. We detect this via stat() inode comparison.
    // On case-sensitive FS this test creates two distinct files and both appear.
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Memory");
    const upperStat = fs.statSync(path.join(tmpDir, "MEMORY.md"));
    let lowerStat: fs.Stats | null = null;
    try {
      lowerStat = fs.statSync(path.join(tmpDir, "memory.md"));
    } catch {
      // Case-sensitive FS — memory.md doesn't exist
    }
    const result = await detectBootstrapFiles(tmpDir);
    const memoryEntries = result.filter((f) => f.toLowerCase() === "memory.md");
    if (lowerStat && lowerStat.ino === upperStat.ino) {
      // Case-insensitive: only one should appear
      expect(memoryEntries).toHaveLength(1);
      expect(memoryEntries[0]).toBe("MEMORY.md");
    } else {
      // Case-sensitive: only MEMORY.md exists
      expect(memoryEntries).toHaveLength(1);
      expect(memoryEntries[0]).toBe("MEMORY.md");
    }
  });

  it("ignores non-date files in memory directory", async () => {
    const memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "heartbeat-state.json"), "{}");
    fs.writeFileSync(path.join(memDir, "2026-02-18.md"), "today");
    const result = await detectBootstrapFiles(tmpDir);
    expect(result).toContain("memory/2026-02-18.md");
    expect(result).not.toContain("memory/heartbeat-state.json");
  });
});

describe("readPostCompactionContext", () => {
  const tmpDir = path.join("/tmp", "test-post-compaction-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no workspace files exist", async () => {
    const result = await readPostCompactionContext(tmpDir);
    expect(result).toBeNull();
  });

  it("lists detected bootstrap files in output", async () => {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "# Soul");
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Memory");
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("SOUL.md");
    expect(result).toContain("MEMORY.md");
    expect(result).toContain("re-read them now");
  });

  it("includes AGENTS.md sections when present", async () => {
    const content = `# Agent Rules

## Session Startup

Read these files:
1. WORKFLOW_AUTO.md
2. memory/today.md

## Other Section

Not relevant.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Session Startup");
    expect(result).toContain("WORKFLOW_AUTO.md");
    expect(result).toContain("Post-compaction context refresh");
    expect(result).not.toContain("Other Section");
  });

  it("extracts Red Lines section", async () => {
    const content = `# Rules

## Red Lines

Never do X.
Never do Y.

## Other

Stuff.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Red Lines");
    expect(result).toContain("Never do X");
  });

  it("extracts Every Session section", async () => {
    const content = `# Rules

## Every Session

Before doing anything else:
1. Read SOUL.md
2. Read USER.md

## Other

Stuff.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Every Session");
    expect(result).toContain("Read SOUL.md");
  });

  it("combines file inventory with AGENTS.md sections", async () => {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "# Soul");
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# Rules\n\n## Red Lines\n\nNever break.\n");
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("SOUL.md");
    expect(result).toContain("AGENTS.md");
    expect(result).toContain("Red Lines");
    expect(result).toContain("Never break");
  });

  it("works with only bootstrap files and no AGENTS.md sections", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# My Agent\n\nSome content.\n");
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "# Soul");
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("AGENTS.md");
    expect(result).toContain("SOUL.md");
    expect(result).toContain("re-read them now");
  });

  it("includes daily memory files in inventory", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# Agent");
    const memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "2026-02-18.md"), "today");
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("memory/2026-02-18.md");
  });

  it("truncates when AGENTS.md sections exceed limit", async () => {
    const longContent = "## Session Startup\n\n" + "A".repeat(4000) + "\n\n## Other\n\nStuff.";
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), longContent);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("[truncated]");
  });

  it("matches section names case-insensitively", async () => {
    const content = `# Rules

## session startup

Read WORKFLOW_AUTO.md

## Other
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("WORKFLOW_AUTO.md");
  });

  it("matches H3 headings", async () => {
    const content = `# Rules

### Session Startup

Read these files.

### Other
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Read these files");
  });

  it("skips sections inside code blocks", async () => {
    const content = `# Rules

\`\`\`markdown
## Session Startup
This is inside a code block and should NOT be extracted.
\`\`\`

## Red Lines

Real red lines here.

## Other
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Real red lines here");
    expect(result).not.toContain("inside a code block");
  });

  it("includes sub-headings within a section", async () => {
    const content = `## Red Lines

### Rule 1
Never do X.

### Rule 2
Never do Y.

## Other Section
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Rule 1");
    expect(result).toContain("Rule 2");
    expect(result).not.toContain("Other Section");
  });
});
