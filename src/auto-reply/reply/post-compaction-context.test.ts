import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { extractSections, readPostCompactionContext } from "./post-compaction-context.js";

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

  it("returns a concise refresh reminder when startup sections exist", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "## Session Startup\n\nRead AGENTS.md and USER.md.\n\n## Red Lines\n\nNever exfiltrate secrets.\n",
    );

    const result = await readPostCompactionContext(tmpDir);
    expect(result).toBe(
      "[Post-compaction context refresh]\n\nSession was compacted. Re-read your startup files, AGENTS.md, SOUL.md, USER.md, and today's memory log, before responding.",
    );
  });

  it("respects explicit disable via postCompactionSections=[]", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "## Session Startup\n\nRead files.\n");

    const cfg = {
      agents: { defaults: { compaction: { postCompactionSections: [] } } },
    } as OpenClawConfig;

    const result = await readPostCompactionContext(tmpDir, cfg);
    expect(result).toBeNull();
  });

  it("falls back to legacy section names for default configs", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "## Every Session\n\nDo the startup sequence.\n\n## Safety\n\nStay safe.\n",
    );

    const result = await readPostCompactionContext(tmpDir);
    expect(result).toContain("Session was compacted.");
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
});

describe("extractSections", () => {
  it("matches headings case insensitively and keeps nested headings", () => {
    const content = `## session startup

Read files.

### Checklist

Do the thing.

## Other`;

    expect(extractSections(content, ["Session Startup"])).toEqual([
      "## session startup\n\nRead files.\n\n### Checklist\n\nDo the thing.",
    ]);
  });

  it("skips headings inside fenced code blocks", () => {
    const content = `\
\`\`\`md
## Session Startup
Ignore this.
\`\`\`

## Red Lines
Real section.`;

    expect(extractSections(content, ["Session Startup"])).toEqual([]);
    expect(extractSections(content, ["Red Lines"])).toEqual(["## Red Lines\nReal section."]);
  });
});
