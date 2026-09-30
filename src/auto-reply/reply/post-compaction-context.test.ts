// Tests post-compaction context loading and prompt attachment behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../agents/workspace-bootstrap-read.js";
import type { OpenClawConfig } from "../../config/config.js";
import { readPostCompactionContext } from "./post-compaction-context.js";

describe("readPostCompactionContext", () => {
  let tmpDir = "";
  const defaultPostCompactionCfg = {
    agents: {
      defaults: {
        compaction: { postCompactionSections: ["Session Startup", "Red Lines"] },
      },
    },
  } satisfies OpenClawConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-post-compaction-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function expectLegacySectionFallback(postCompactionSections: string[]) {
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
    expect(result).toContain("Run your Session Startup sequence");
  }

  async function readDefaultPostCompactionContext(options?: {
    cfg?: OpenClawConfig;
    agentId?: string;
    nowMs?: number;
  }) {
    const cfg = {
      ...defaultPostCompactionCfg,
      ...options?.cfg,
      agents: {
        ...defaultPostCompactionCfg.agents,
        ...options?.cfg?.agents,
        defaults: {
          ...defaultPostCompactionCfg.agents.defaults,
          ...options?.cfg?.agents?.defaults,
          compaction: {
            ...defaultPostCompactionCfg.agents.defaults.compaction,
            ...options?.cfg?.agents?.defaults?.compaction,
          },
        },
      },
    } as OpenClawConfig;
    return readPostCompactionContext(tmpDir, { ...options, cfg });
  }

  it("returns null when no AGENTS.md exists", async () => {
    const result = await readPostCompactionContext(tmpDir);
    expect(result).toBeNull();
  });

  it.each(["available", "revoked", "oversized", "unavailable", "invalid-utf8"] as const)(
    "reads remote post-compaction rules without stale local fallback when %s",
    async (state) => {
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "## Session Startup\nStale local rules.");
      let release = () => {};
      const readFile = vi.fn(async () => {
        if (state === "unavailable") {
          throw new Error("Remote workspace is unavailable");
        }
        if (state === "revoked") {
          release();
        }
        if (state === "oversized") {
          return Buffer.alloc(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1);
        }
        return state === "invalid-utf8"
          ? Buffer.from([0xff])
          : Buffer.from("## Session Startup\nRemote rules.");
      });
      release = registerAgentWorkspaceAccess(tmpDir, {
        bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
      });
      try {
        const result = await readDefaultPostCompactionContext();
        if (state === "available") {
          expect(result).toContain("Remote rules.");
          expect(result).not.toContain("Stale local rules.");
        } else {
          expect(result).toBeNull();
        }
        expect(readFile).toHaveBeenCalledWith({
          filePath: "AGENTS.md",
          maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        });
        release();
        expect(await readDefaultPostCompactionContext()).toBeNull();
        expect(readFile).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
    },
  );

  it("returns null when AGENTS.md has no relevant sections", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# My Agent\n\nSome content.\n");
    const result = await readDefaultPostCompactionContext();
    expect(result).toBeNull();
  });

  it("returns null when AGENTS.md exceeds the byte read limit", async () => {
    // An unbounded read would extract the section header at the top of the file;
    // the bound rejects the whole file instead of allocating it all.
    const oversized = `## Session Startup\n\n` + "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES);
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), oversized);
    const result = await readDefaultPostCompactionContext();
    expect(result).toBeNull();
  });

  it("extracts sections from an AGENTS.md just under the byte read limit", async () => {
    const section = `## Session Startup\n\nDo startup things.\n`;
    const padding = "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - section.length);
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), section + padding);
    const result = await readDefaultPostCompactionContext();
    expect(result).toContain("Do startup things");
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
    const result = await readDefaultPostCompactionContext();
    expect(result).toContain("Session Startup");
    expect(result).toContain("Red Lines");
    expect(result).toContain("Do startup things");
    expect(result).toContain("Never break things");
    expect(result).toContain("Post-compaction context refresh");
    expect(result).toContain("Run your Session Startup sequence");
    expect(result).not.toContain("Other");
  });

  it("truncates when content exceeds limit", async () => {
    const longContent = "## Session Startup\n\n" + "A".repeat(4000) + "\n\n## Other\n\nStuff.";
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), longContent);
    const result = await readDefaultPostCompactionContext();
    expect(result).toContain("[truncated]");
    expect(result?.length).toBeLessThan(2600);
  });

  it("keeps truncated post-compaction context UTF-16 safe", async () => {
    const prefix = "A".repeat(159);
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), `## Session Startup\n\n${prefix}😀tail`);
    const cfg = {
      agents: {
        defaults: {
          contextLimits: { postCompactionMaxChars: 180 },
        },
      },
    } as OpenClawConfig;

    const result = await readDefaultPostCompactionContext({ cfg });

    expect(result).toContain(`## Session Startup\n\n${prefix}\n...[truncated]...`);
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

    const result = await readDefaultPostCompactionContext({ cfg, agentId: "writer" });
    expect(result).toContain("[truncated]");
    expect(result?.length).toBeLessThan(1_200);
  });

  it("matches H3 headings", async () => {
    const content = `# Rules

### Session Startup

Read these files.

### Other
`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readDefaultPostCompactionContext();
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
    const result = await readDefaultPostCompactionContext();
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
    const result = await readDefaultPostCompactionContext();
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

      const result = await readDefaultPostCompactionContext();
      expect(result).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns null when AGENTS.md is a hardlink alias",
    async () => {
      const outside = path.join(tmpDir, "outside-secret.txt");
      fs.writeFileSync(outside, "secret");
      fs.linkSync(outside, path.join(tmpDir, "AGENTS.md"));

      const result = await readDefaultPostCompactionContext();
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
    const result = await readDefaultPostCompactionContext({ cfg, nowMs });
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
    const result = await readDefaultPostCompactionContext({ nowMs });
    expect(result).toContain("Current time:");
  });

  // -------------------------------------------------------------------------
  // postCompactionSections config
  // -------------------------------------------------------------------------
  describe("agents.defaults.compaction.postCompactionSections", () => {
    it("returns null when postCompactionSections is not configured", async () => {
      const content = `## Session Startup\n\nDo startup.\n\n## Red Lines\n\nDo not break.\n\n## Other\n\nIgnore.\n`;
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
      const result = await readPostCompactionContext(tmpDir);
      expect(result).toBeNull();
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
      expect(result).not.toContain("Session Startup");
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

    it("falls back to legacy sections when default sections are configured in a different order", async () => {
      await expectLegacySectionFallback(["Red Lines", "Session Startup"]);
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
});
