import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readPostCompactionContext } from "./post-compaction-context.js";

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
});
