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

  async function expectLegacySectionFallback(
    postCompactionSections: string[],
    expectDefaultProse = false,
  ) {
    const content = `## Every Session\n\nDo startup things.\n\n## Safety\n\nBe safe.\n`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const cfg = {
      agents: {
        defaults: {
          compaction: { postCompactionSections },
        },
      },
    } as OpenClawConfig;
    const result = await readPostCompactionContext(tmpDir, { cfg });
    expect(result).toContain("Do startup things");
    expect(result).toContain("Be safe");
    if (expectDefaultProse) {
      expect(result).toContain("CONTINUE the unfinished task");
    }
  }

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
    expect(result).toContain("Session Startup");
    expect(result).toContain("Red Lines");
    expect(result).not.toContain("Other");
  });

  it("truncates when content exceeds limit", async () => {
    const longContent = "## Session Startup\n\n" + "A".repeat(4000) + "\n\n## Other\n\nStuff.";
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), longContent);
    const result = await readPostCompactionContext(tmpDir);
    expect(result).toContain("[truncated]");
    expect(result?.length).toBeLessThan(2600);
  });

  it("honors per-agent post-compaction context limit overrides", async () => {
    const longContent =
      "## Session Startup\n\n" + "B".repeat(4000) + "\n\n## Red Lines\n\nGuardrails.";
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), longContent);
    const cfg = {
      agents: {
        defaults: {
          contextLimits: {
            postCompactionMaxChars: 1800,
          },
        },
        list: [
          {
            id: "writer",
            contextLimits: {
              postCompactionMaxChars: 300,
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = await readPostCompactionContext(tmpDir, { cfg, agentId: "writer" });
    expect(result).toContain("[truncated]");
    expect(result?.length).toBeLessThan(1_200);
  });

  it("matches section names case-insensitively", async () => {
    const content = `# Rules

## session startup

Read WORKFLOW_AUTO.md

## Other
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readPostCompactionContext(tmpDir);
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
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;
    // 2026-03-03 14:00 UTC = 2026-03-03 09:00 EST
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const result = await readPostCompactionContext(tmpDir, { cfg, nowMs });
    expect(result).toContain("memory/2026-03-03.md");
    expect(result).not.toContain("memory/YYYY-MM-DD.md");
    expect(result).toContain("Current time: Tuesday, March 3rd, 2026 - 9:00 AM (America/New_York)");
    expect(result).toContain("Reference UTC: 2026-03-03 14:00 UTC");
  });

  it("appends current time line even when no YYYY-MM-DD placeholder is present", async () => {
    const content = `## Session Startup

Read WORKFLOW.md on startup.
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const result = await readPostCompactionContext(tmpDir, { nowMs });
    expect(result).toContain("Current time:");
  });

  // -------------------------------------------------------------------------
  // postCompactionSections config
  // -------------------------------------------------------------------------
  describe("agents.defaults.compaction.postCompactionSections", () => {
    it("uses default sections (Session Startup + Red Lines) when config is not set", async () => {
      const content = `## Session Startup\n\nDo startup.\n\n## Red Lines\n\nDo not break.\n\n## Other\n\nIgnore.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const result = await readPostCompactionContext(tmpDir);
      expect(result).toContain("Session Startup");
      expect(result).toContain("Red Lines");
      expect(result).not.toContain("Other");
    });

    it("uses custom section names from config instead of defaults", async () => {
      const content = `## Session Startup\n\nDo startup.\n\n## Critical Rules\n\nMy custom rules.\n\n## Red Lines\n\nDefault section.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const cfg = {
        agents: {
          defaults: {
            compaction: { postCompactionSections: ["Critical Rules"] },
          },
        },
      } as OpenClawConfig;
      const result = await readPostCompactionContext(tmpDir, { cfg });
      expect(result).toContain("Critical Rules");
      expect(result).toContain("My custom rules");
      // Default sections must not be included when overridden
      expect(result).not.toContain("Do startup");
      expect(result).not.toContain("Default section");
    });

    it("supports multiple custom section names", async () => {
      const content = `## Onboarding\n\nOnboard things.\n\n## Safety\n\nSafe things.\n\n## Noise\n\nIgnore.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const cfg = {
        agents: {
          defaults: {
            compaction: { postCompactionSections: ["Onboarding", "Safety"] },
          },
        },
      } as OpenClawConfig;
      const result = await readPostCompactionContext(tmpDir, { cfg });
      expect(result).toContain("Onboard things");
      expect(result).toContain("Safe things");
      expect(result).not.toContain("Ignore");
    });

    it("returns null when postCompactionSections is explicitly set to [] (opt-out)", async () => {
      const content = `## Session Startup\n\nDo startup.\n\n## Red Lines\n\nDo not break.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const cfg = {
        agents: {
          defaults: {
            compaction: { postCompactionSections: [] },
          },
        },
      } as OpenClawConfig;
      const result = await readPostCompactionContext(tmpDir, { cfg });
      // Empty array = opt-out: no post-compaction context injection
      expect(result).toBeNull();
    });

    it("returns null when custom sections are configured but none found in AGENTS.md", async () => {
      const content = `## Session Startup\n\nDo startup.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const cfg = {
        agents: {
          defaults: {
            compaction: { postCompactionSections: ["Nonexistent Section"] },
          },
        },
      } as OpenClawConfig;
      const result = await readPostCompactionContext(tmpDir, { cfg });
      expect(result).toBeNull();
    });

    it("does NOT reference 'Session Startup' in prose when custom sections are configured", async () => {
      // Greptile review finding: hardcoded prose mentioned "Execute your Session Startup
      // sequence now" even when custom section names were configured, causing agents to
      // look for a non-existent section. Prose must adapt to the configured section names.
      const content = `## Boot Sequence\n\nDo custom boot things.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const cfg = {
        agents: {
          defaults: {
            compaction: { postCompactionSections: ["Boot Sequence"] },
          },
        },
      } as OpenClawConfig;
      const result = await readPostCompactionContext(tmpDir, { cfg });
      // Must not reference the hardcoded default section name
      expect(result).not.toContain("Session Startup");
      // Must reference the actual configured section names
      expect(result).toContain("Boot Sequence");
    });

    it("uses default 'Session Startup' prose when default sections are active", async () => {
      const content = `## Session Startup\n\nDo startup.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const result = await readPostCompactionContext(tmpDir);
      expect(result).toContain("CONTINUE the unfinished task");
    });

    it("falls back to legacy sections when defaults are explicitly configured", async () => {
      // Older AGENTS.md templates use "Every Session" / "Safety" instead of
      // "Session Startup" / "Red Lines". Explicitly setting the defaults should
      // still trigger the legacy fallback — same behavior as leaving the field unset.
      await expectLegacySectionFallback(["Session Startup", "Red Lines"]);
    });

    it("falls back to legacy sections when default sections are configured in a different order", async () => {
      await expectLegacySectionFallback(["Red Lines", "Session Startup"], true);
    });

    it("custom section names are matched case-insensitively", async () => {
      const content = `## WORKFLOW INIT\n\nInit things.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const cfg = {
        agents: {
          defaults: {
            compaction: { postCompactionSections: ["workflow init"] },
          },
        },
      } as OpenClawConfig;
      const result = await readPostCompactionContext(tmpDir, { cfg });
      expect(result).toContain("Init things");
    });
  });

  describe("compaction summary injection", () => {
    it("injects compaction summary when sessionFile is provided", async () => {
      const content = `## Session Startup\n\nDo startup.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);

      // Create a mock transcript file with a compaction entry
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const compactionEntry = JSON.stringify({
        type: "compaction",
        id: "cmp1",
        summary: "User asked to fix the login bug. Fixed auth.ts line 42. Tests pass. Next: deploy to staging.",
        firstKeptEntryId: "kept1",
      });
      fs.writeFileSync(sessionFile, compactionEntry + "\n");

      const result = await readPostCompactionContext(tmpDir, { sessionFile });
      expect(result).not.toBeNull();
      expect(result).toContain("<compaction-summary>");
      expect(result).toContain("login bug");
      expect(result).toContain("auth.ts");
      expect(result).toContain("</compaction-summary>");
      expect(result).toContain("CONTINUE the unfinished task");
    });

    it("works without sessionFile (backward compatible)", async () => {
      const content = `## Session Startup\n\nDo startup.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);

      const result = await readPostCompactionContext(tmpDir);
      expect(result).not.toBeNull();
      expect(result).not.toContain("<compaction-summary>");
      expect(result).toContain("CONTINUE the unfinished task");
    });

    it("finds latest compaction when multiple exist", async () => {
      const content = `## Session Startup\n\nDo startup.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "compaction", id: "c1", summary: "Old summary about task X." }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user" } }),
        JSON.stringify({ type: "compaction", id: "c2", summary: "New summary about task Y. Last action: deployed fix." }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant" } }),
      ];
      fs.writeFileSync(sessionFile, lines.join("\n") + "\n");

      const result = await readPostCompactionContext(tmpDir, { sessionFile });
      expect(result).not.toBeNull();
      expect(result).toContain("task Y");
      expect(result).toContain("deployed fix");
      expect(result).not.toContain("task X");
    });

    it("handles missing sessionFile gracefully", async () => {
      const content = `## Session Startup\n\nDo startup.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);

      const result = await readPostCompactionContext(tmpDir, {
        sessionFile: "/nonexistent/session.jsonl",
      });
      expect(result).not.toBeNull();
      // Should still work, just without compaction summary
      expect(result).not.toContain("<compaction-summary>");
    });

    it("truncates very long compaction summaries", async () => {
      const content = `## Session Startup\n\nDo startup.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);

      const sessionFile = path.join(tmpDir, "session.jsonl");
      const longSummary = "A".repeat(10000);
      const compactionEntry = JSON.stringify({
        type: "compaction",
        id: "cmp1",
        summary: longSummary,
      });
      fs.writeFileSync(sessionFile, compactionEntry + "\n");

      const result = await readPostCompactionContext(tmpDir, { sessionFile });
      expect(result).not.toBeNull();
      expect(result).toContain("[compaction summary truncated]");
    });
  });
});
