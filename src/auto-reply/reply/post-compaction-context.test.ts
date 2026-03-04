import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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

  it.runIf(process.platform !== "win32")(
    "returns null when AGENTS.md is a symlink escaping workspace",
    async () => {
      const outside = path.join(tmpDir, "outside-secret.txt");
      fs.writeFileSync(outside, "secret");
      fs.symlinkSync(outside, path.join(tmpDir, "AGENTS.md"));

      const result = await readPostCompactionContext(tmpDir);
      expect(result).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns null when AGENTS.md is a hardlink alias",
    async () => {
      const outside = path.join(tmpDir, "outside-secret.txt");
      fs.writeFileSync(outside, "secret");
      fs.linkSync(outside, path.join(tmpDir, "AGENTS.md"));

      const result = await readPostCompactionContext(tmpDir);
      expect(result).toBeNull();
    },
  );

  it("substitutes YYYY-MM-DD with the actual date in extracted sections", async () => {
    const content = `## Session Startup

Read memory/YYYY-MM-DD.md and memory/yesterday.md.

## Red Lines

Never modify memory/YYYY-MM-DD.md destructively.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York" } },
    } as OpenClawConfig;
    // 2026-03-03 14:00 UTC = 2026-03-03 09:00 EST
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const result = await readPostCompactionContext(tmpDir, cfg, nowMs);
    expect(result).not.toBeNull();
    expect(result).toContain("memory/2026-03-03.md");
    expect(result).not.toContain("memory/YYYY-MM-DD.md");
    expect(result).toContain("Current time:");
    expect(result).toContain("America/New_York");
  });

  it("uses configured preserveSections instead of defaults", async () => {
    const content = `# My Agent

## Safety

Never delete production data.

## Things You Must NEVER Get Wrong

Always double-check before sending emails.

## Session Startup

Default section that should be ignored when custom sections are configured.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            preserveSections: ["Safety", "Things You Must NEVER Get Wrong"],
          },
        },
      },
    } as OpenClawConfig;
    const result = await readPostCompactionContext(tmpDir, cfg);
    expect(result).not.toBeNull();
    expect(result).toContain("Never delete production data");
    expect(result).toContain("Always double-check before sending emails");
    expect(result).not.toContain("Default section that should be ignored");
  });

  it("falls back to defaults when preserveSections is empty", async () => {
    const content = `## Session Startup

Read startup files.

## Safety

Custom section.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            preserveSections: [],
          },
        },
      },
    } as OpenClawConfig;
    const result = await readPostCompactionContext(tmpDir, cfg);
    expect(result).not.toBeNull();
    expect(result).toContain("Read startup files");
    expect(result).not.toContain("Custom section");
  });

  it("falls back to defaults when preserveSections is not configured", async () => {
    const content = `## Session Startup

Default preserved.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Default preserved");
  });

  it("appends current time line even when no YYYY-MM-DD placeholder is present", async () => {
    const content = `## Session Startup

Read WORKFLOW.md on startup.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const result = await readPostCompactionContext(tmpDir, undefined, nowMs);
    expect(result).not.toBeNull();
    expect(result).toContain("Current time:");
  });
});
