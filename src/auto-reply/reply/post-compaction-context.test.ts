import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../agents/workspace-bootstrap-read.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import {
  appendPostCompactionRefreshPrompt,
  readPostCompactionContext,
} from "./post-compaction-context.js";

describe("readPostCompactionContext", () => {
  let tmpDir = "";
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-post-compaction-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function readRules(
    content?: string,
    options: {
      maxChars?: number;
      sections?: string[];
      agents?: NonNullable<OpenClawConfig["agents"]>["entries"];
      agentId?: string;
    } = {},
  ) {
    if (content !== undefined) {
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), content);
    }
    const cfg: OpenClawConfig = {
      agents: {
        entries: options.agents,
        defaults: {
          compaction: {
            postCompactionSections: options.sections ?? ["Session Startup", "Red Lines"],
          },
          contextLimits: { postCompactionMaxChars: options.maxChars },
        },
      },
    };
    return readPostCompactionContext(tmpDir, { agentId: options.agentId, cfg });
  }

  it.each([
    undefined,
    "# My Agent\n\nSome content.\n",
    `## Session Startup\n\n${"x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}`,
  ])("returns null for absent, irrelevant, or oversized AGENTS.md: %#", async (content) => {
    expect(await readRules(content)).toBeNull();
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
        const result = await readRules();
        if (state === "available") {
          expect(result).toContain("Remote rules.");
          expect(result).not.toContain("Stale local rules.");
        } else {
          expect(result).toBeNull();
        }
        release();
        expect(await readRules()).toBeNull();
        expect(readFile).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
    },
  );

  it("preserves existing prompt bytes when appending post-compaction context", async () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "## Session Startup\nRead files.");
    const followupRun = createTestFollowupRun({
      workspaceDir: tmpDir,
      extraSystemPrompt: "### Delivery Format\nSynthetic contract.\n",
    });

    await appendPostCompactionRefreshPrompt({
      cfg: {
        agents: { defaults: { compaction: { postCompactionSections: ["Session Startup"] } } },
      },
      followupRun,
    });

    expect(followupRun.run.extraSystemPrompt).toMatch(
      /^### Delivery Format\nSynthetic contract\.\n\n\n/,
    );
    expect(followupRun.run.extraSystemPrompt).toContain("Read files.");
  });

  it("keeps truncated post-compaction context UTF-16 safe", async () => {
    const prefix = "A".repeat(159);
    const result = await readRules(`## Session Startup\n\n${prefix}😀tail`, { maxChars: 180 });
    expect(result).toContain(`## Session Startup\n\n${prefix}\n...[truncated]...`);
  });

  it("honors per-agent post-compaction context limit overrides", async () => {
    const longContent =
      "## Session Startup\n\n" + "B".repeat(4000) + "\n\n## Red Lines\n\nGuardrails.";
    const result = await readRules(longContent, {
      maxChars: 1800,
      agents: { writer: { contextLimits: { postCompactionMaxChars: 300 } } },
      agentId: "writer",
    });
    expect(result).toContain("[truncated]");
    expect(result?.length).toBeLessThan(1_200);
  });

  it.each<[string, string, RegExp, RegExp, Parameters<typeof readRules>[1]]>([
    [
      "ignores headings in fences",
      "```markdown\n## Session Startup\ninside a code block\n```\n## Red Lines\nReal red lines here\n## Other",
      /Real red lines here/,
      /inside a code block/,
      {},
    ],
    [
      "preserves nested fences",
      "## Session Startup\n\n````markdown\n```bash\n# setup\n```\n# Example heading\n````\n\nAfter fence.\n\n# Appendix\n\nAppendix body.\n",
      /# setup\n```\n# Example heading\n````\n\nAfter fence\./,
      /Appendix body\./,
      {},
    ],
    [
      "ends at H1 before budgeting later sections",
      `## Session Startup\n\nRead files.\n\n# Appendix\n\n${"A".repeat(3000)}\n\n## Red Lines\n\nNever do X.\n`,
      /Read files\.[\s\S]*Never do X\./,
      /Appendix|\[truncated\]/,
      { maxChars: 200 },
    ],
    [
      "uses configured sections",
      "## Session Startup\nDo startup\n## Critical Rules\nMy custom rules\n## Red Lines\nDefault section",
      /Critical Rules\nMy custom rules/,
      /Do startup|Default section|Session Startup/,
      { sections: ["Critical Rules"] },
    ],
  ])("%s", async (_name, content, included, excluded, options) => {
    const result = await readRules(content, options);
    expect(result).toMatch(included);
    expect(result).not.toMatch(excluded);
  });
});
