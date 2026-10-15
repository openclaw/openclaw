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

  it.each(["available", "revoked", "oversized"] as const)(
    "reads remote post-compaction rules without stale local fallback when %s",
    async (state) => {
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "## Session Startup\nStale local rules.");
      let release = () => {};
      const readFile = vi.fn(async () => {
        if (state === "revoked") {
          release();
        }
        if (state === "oversized") {
          return Buffer.alloc(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1);
        }
        return Buffer.from("## Session Startup\nRemote rules.");
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
        entries: {
          writer: {
            contextLimits: {
              postCompactionMaxChars: 300,
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await readDefaultPostCompactionContext({ cfg, agentId: "writer" });
    expect(result).toContain("[truncated]");
    expect(result?.length).toBeLessThan(1_200);
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

  it("keeps a nested backtick block inside a four-backtick fence in the selected section", async () => {
    const content =
      "## Session Startup\n\n````markdown\n```bash\n# setup\n```\n# Example heading\n````\n\nAfter fence.\n\n# Appendix\n\nAppendix body.\n";
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const result = await readDefaultPostCompactionContext();
    expect(result).toContain("# setup\n```\n# Example heading\n````\n\nAfter fence.");
    expect(result).not.toContain("Appendix body.");
  });

  it("ends a selected section at an H1 so a later section fits the budget", async () => {
    const content = `## Session Startup\n\nRead files.\n\n# Appendix\n\n${"A".repeat(3000)}\n\n## Red Lines\n\nNever do X.\n`;
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    const cfg = {
      agents: { defaults: { contextLimits: { postCompactionMaxChars: 200 } } },
    } as OpenClawConfig;
    const result = await readDefaultPostCompactionContext({ cfg });
    expect(result).toContain("Read files.");
    expect(result).toContain("Never do X.");
    expect(result).not.toContain("Appendix");
    expect(result).not.toContain("[truncated]");
  });

  // -------------------------------------------------------------------------
  // postCompactionSections config
  // -------------------------------------------------------------------------
  describe("agents.defaults.compaction.postCompactionSections", () => {
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
  });
});
