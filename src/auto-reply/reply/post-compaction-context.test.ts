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
        expect(readFile).toHaveBeenCalledWith({
          filePath: "AGENTS.md",
          maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        });
        release();
        expect(await readRules()).toBeNull();
        expect(readFile).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
    },
  );

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

  it("skips sections inside code blocks", async () => {
    const result = await readRules(
      "```markdown\n## Session Startup\ninside a code block\n```\n## Red Lines\nReal red lines here\n## Other",
    );
    expect(result).toContain("Real red lines here");
    expect(result).not.toContain("inside a code block");
  });

  it("keeps a nested backtick block inside a four-backtick fence in the selected section", async () => {
    const content =
      "## Session Startup\n\n````markdown\n```bash\n# setup\n```\n# Example heading\n````\n\nAfter fence.\n\n# Appendix\n\nAppendix body.\n";
    const result = await readRules(content);
    expect(result).toContain("# setup\n```\n# Example heading\n````\n\nAfter fence.");
    expect(result).not.toContain("Appendix body.");
  });

  it("ends a selected section at an H1 so a later section fits the budget", async () => {
    const content = `## Session Startup\n\nRead files.\n\n# Appendix\n\n${"A".repeat(3000)}\n\n## Red Lines\n\nNever do X.\n`;
    const result = await readRules(content, { maxChars: 200 });
    expect(result).toContain("Read files.");
    expect(result).toContain("Never do X.");
    expect(result).not.toContain("Appendix");
    expect(result).not.toContain("[truncated]");
  });

  it("uses custom section names from config instead of defaults", async () => {
    const result = await readRules(
      "## Session Startup\nDo startup\n## Critical Rules\nMy custom rules\n## Red Lines\nDefault section",
      { sections: ["Critical Rules"] },
    );
    expect(result).toContain("Critical Rules\nMy custom rules");
    expect(result).not.toMatch(/Do startup|Default section|Session Startup/);
  });
});
