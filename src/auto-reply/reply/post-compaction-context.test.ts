import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractStartupFileCandidates,
  readPostCompactionContext,
  resolveExistingStartupFiles,
} from "./post-compaction-context.js";

describe("readPostCompactionContext", () => {
  const tmpDir = path.join("/tmp", "test-post-compaction-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no AGENTS.md exists", async () => {
    const result = await readPostCompactionContext(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when AGENTS.md has no relevant sections", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# My Agent\n\nSome content.\n");
    const result = await readPostCompactionContext(tmpDir);
    expect(result).toBeNull();
  });

  it("extracts Session Startup section", async () => {
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

  it("extracts both sections", async () => {
    const content = `# Rules

## Session Startup

Do startup things.

## Red Lines

Never break things.

## Other

Ignore this.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Session Startup");
    expect(result).toContain("Red Lines");
    expect(result).not.toContain("Other");
  });

  it("truncates when content exceeds limit", async () => {
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

  it("appends list of existing startup files when Session Startup references files", async () => {
    fs.mkdirSync(path.join(tmpDir, "memory"), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "# Soul");
    fs.writeFileSync(path.join(tmpDir, "memory", `${today}.md`), "# Today");
    const content = `# Agent

## Session Startup

1. Read \`SOUL.md\`
2. Read \`memory/YYYY-MM-DD.md\`
3. Read \`WORKFLOW_AUTO.md\`

## Red Lines

Never delete files.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("The following startup files exist in your workspace");
    expect(result).toContain("- SOUL.md");
    expect(result).toContain(`- memory/${today}.md`);
    expect(result).not.toMatch(/- WORKFLOW_AUTO\.md\b/);
  });
});

describe("extractStartupFileCandidates", () => {
  it("extracts backtick-wrapped .md paths", () => {
    const text = "Read `SOUL.md` and `USER.md`.";
    expect(extractStartupFileCandidates(text)).toContain("SOUL.md");
    expect(extractStartupFileCandidates(text)).toContain("USER.md");
  });

  it("extracts Read X.md patterns", () => {
    const text = "Read WORKFLOW_AUTO.md before starting.";
    expect(extractStartupFileCandidates(text)).toContain("WORKFLOW_AUTO.md");
  });

  it("extracts numbered list items", () => {
    const text = "1. WORKFLOW_AUTO.md\n2. memory/today.md";
    const out = extractStartupFileCandidates(text);
    expect(out).toContain("WORKFLOW_AUTO.md");
    expect(out).toContain("memory/today.md");
  });

  it("adds memory/YYYY-MM-DD.md when placeholder appears", () => {
    const text = "Read memory/YYYY-MM-DD.md (today).";
    expect(extractStartupFileCandidates(text)).toContain("memory/YYYY-MM-DD.md");
  });
});

describe("resolveExistingStartupFiles", () => {
  const workspaceDir = path.join("/tmp", "test-resolve-startup-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns only paths that exist under workspace", () => {
    fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "");
    const out = resolveExistingStartupFiles(
      workspaceDir,
      ["SOUL.md", "WORKFLOW_AUTO.md"],
      "UTC",
      Date.now(),
    );
    expect(out).toEqual(["SOUL.md"]);
  });

  it("expands memory/YYYY-MM-DD.md to today and yesterday when they exist", () => {
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86400 * 1000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(workspaceDir, "memory", `${today}.md`), "");
    fs.writeFileSync(path.join(workspaceDir, "memory", `${yesterday}.md`), "");
    const out = resolveExistingStartupFiles(
      workspaceDir,
      ["memory/YYYY-MM-DD.md"],
      "UTC",
      now.getTime(),
    );
    expect(out).toContain(`memory/${today}.md`);
    expect(out).toContain(`memory/${yesterday}.md`);
  });
});
