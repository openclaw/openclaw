import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearAllBootstrapSnapshots,
  getOrLoadBootstrapFiles,
} from "../../agents/bootstrap-cache.js";
import { readPostCompactionContext } from "./post-compaction-context.js";

vi.mock("../../agents/workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

import { loadWorkspaceBootstrapFiles } from "../../agents/workspace.js";

const mockLoad = vi.mocked(loadWorkspaceBootstrapFiles);

describe("readPostCompactionContext", () => {
  const tmpDir = path.join("/tmp", "test-post-compaction-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    clearAllBootstrapSnapshots();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
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

describe("readPostCompactionContext — cache integration", () => {
  const tmpDir = path.join("/tmp", "test-post-compaction-cache-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    clearAllBootstrapSnapshots();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("uses cached AGENTS.md content when session key matches", async () => {
    const cachedContent = `## Session Startup\n\nFrom cache.\n\n## Other\n\nIgnored.`;
    mockLoad.mockResolvedValue([
      {
        name: "AGENTS.md",
        path: path.join(tmpDir, "AGENTS.md"),
        content: cachedContent,
        missing: false,
      },
    ]);

    // Populate cache
    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "sk-cache-test" });

    // Write different content to disk — cache should win
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "## Session Startup\n\nFrom disk (should be ignored).\n",
    );

    const result = await readPostCompactionContext(tmpDir, { sessionKey: "sk-cache-test" });
    expect(result).not.toBeNull();
    expect(result).toContain("From cache");
    expect(result).not.toContain("From disk");
  });

  it("falls back to disk when no cache entry for session key", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "## Session Startup\n\nFrom disk.\n\n## Other\n\nStuff.\n",
    );

    const result = await readPostCompactionContext(tmpDir, { sessionKey: "no-cache-for-this" });
    expect(result).not.toBeNull();
    expect(result).toContain("From disk");
  });

  it("falls back to disk when no opts provided", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "## Red Lines\n\nNever break things.\n\n## Other\n\nStuff.\n",
    );

    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Never break things");
  });

  it("returns null when cache has no AGENTS.md and no disk file", async () => {
    mockLoad.mockResolvedValue([
      { name: "SOUL.md", path: path.join(tmpDir, "SOUL.md"), content: "# Soul", missing: false },
    ]);

    await getOrLoadBootstrapFiles({ workspaceDir: tmpDir, sessionKey: "sk-no-agents" });

    const result = await readPostCompactionContext(tmpDir, { sessionKey: "sk-no-agents" });
    expect(result).toBeNull();
  });
});
