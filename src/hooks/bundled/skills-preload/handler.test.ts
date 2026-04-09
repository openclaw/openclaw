import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function createSkillsPreloadConfig(enabled = true): OpenClawConfig {
  return {
    hooks: {
      internal: {
        enabled: true,
        entries: {
          "skills-preload": { enabled },
        },
      },
    },
  };
}

async function createBootstrapContext(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  rootFiles: Array<{ name: string; content: string }>;
}): Promise<AgentBootstrapHookContext> {
  const bootstrapFiles = (await Promise.all(
    params.rootFiles.map(async (file) => ({
      name: file.name,
      path: await writeWorkspaceFile({
        dir: params.workspaceDir,
        name: file.name,
        content: file.content,
      }),
      content: file.content,
      missing: false,
    })),
  )) as AgentBootstrapHookContext["bootstrapFiles"];
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  };
}

async function writeSkillWithPreload(
  workspaceDir: string,
  skillName: string,
  opts: {
    preload?: boolean;
    preloadFiles?: string[];
    extraFiles?: Record<string, string>;
  } = {},
): Promise<void> {
  const skillDir = path.join(workspaceDir, "skills", skillName);
  await fs.mkdir(skillDir, { recursive: true });

  const frontmatter = [
    "---",
    `name: ${skillName}`,
    `description: Test skill`,
  ];
  if (opts.preload !== undefined) {
    frontmatter.push(`preload: ${opts.preload}`);
  }
  if (opts.preloadFiles && opts.preloadFiles.length > 0) {
    frontmatter.push(`preload-files: ${JSON.stringify(opts.preloadFiles)}`);
  }
  frontmatter.push("---", "", `# ${skillName} content`);

  await fs.writeFile(path.join(skillDir, "SKILL.md"), frontmatter.join("\n"), "utf-8");

  if (opts.extraFiles) {
    for (const [name, content] of Object.entries(opts.extraFiles)) {
      await fs.writeFile(path.join(skillDir, name), content, "utf-8");
    }
  }
}

describe("skills-preload hook", () => {
  it("preloads SKILL.md when preload: true is set", async () => {
    const tempDir = await makeTempWorkspace("openclaw-skills-preload-");
    const cfg = createSkillsPreloadConfig();
    await writeSkillWithPreload(tempDir, "test-skill", { preload: true });

    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    // Should have root AGENTS.md + the preloaded SKILL.md
    expect(context.bootstrapFiles.length).toBeGreaterThanOrEqual(2);
    const preloaded = context.bootstrapFiles.find((f) =>
      f.path.includes(path.join("skills", "test-skill", "SKILL.md")),
    );
    expect(preloaded).toBeDefined();
    expect(preloaded!.content).toContain("# test-skill content");
  });

  it("does NOT preload when preload is not set", async () => {
    const tempDir = await makeTempWorkspace("openclaw-skills-preload-skip-");
    const cfg = createSkillsPreloadConfig();
    await writeSkillWithPreload(tempDir, "no-preload-skill", { preload: false });

    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    // Should only have the original root file
    expect(context.bootstrapFiles).toHaveLength(1);
  });

  it("preloads sibling files listed in preload-files", async () => {
    const tempDir = await makeTempWorkspace("openclaw-skills-preload-siblings-");
    const cfg = createSkillsPreloadConfig();
    await writeSkillWithPreload(tempDir, "multi-file-skill", {
      preload: true,
      preloadFiles: ["pricing.md", "faq.md"],
      extraFiles: {
        "pricing.md": "# Pricing\nPremium: $500/mo",
        "faq.md": "# FAQ\nQ: How? A: Like this.",
      },
    });

    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    // Root AGENTS.md + SKILL.md + pricing.md + faq.md = 4
    expect(context.bootstrapFiles.length).toBeGreaterThanOrEqual(4);
    const pricingFile = context.bootstrapFiles.find((f) => f.path.includes("pricing.md"));
    expect(pricingFile).toBeDefined();
    expect(pricingFile!.content).toContain("Premium: $500/mo");
    const faqFile = context.bootstrapFiles.find((f) => f.path.includes("faq.md"));
    expect(faqFile).toBeDefined();
  });

  it("rejects path traversal in preload-files", async () => {
    const tempDir = await makeTempWorkspace("openclaw-skills-preload-traversal-");
    const cfg = createSkillsPreloadConfig();
    await writeSkillWithPreload(tempDir, "evil-skill", {
      preload: true,
      preloadFiles: ["../../etc/passwd"],
    });

    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    // Should only have root AGENTS.md + SKILL.md (traversal file rejected)
    const traversalFile = context.bootstrapFiles.find((f) => f.path.includes("passwd"));
    expect(traversalFile).toBeUndefined();
  });

  it("skips when hook is explicitly disabled", async () => {
    const tempDir = await makeTempWorkspace("openclaw-skills-preload-disabled-");
    const cfg = createSkillsPreloadConfig(false);
    await writeSkillWithPreload(tempDir, "disabled-skill", { preload: true });

    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    // Should only have the original root file — nothing preloaded
    expect(context.bootstrapFiles).toHaveLength(1);
  });

  it("skips non-agent:bootstrap events", async () => {
    const tempDir = await makeTempWorkspace("openclaw-skills-preload-wrong-event-");
    const cfg = createSkillsPreloadConfig();

    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    // Send a session event instead of agent:bootstrap
    const event = createHookEvent("session", "start", "agent:main:main", context);
    await handler(event);

    // Nothing should change
    expect(context.bootstrapFiles).toHaveLength(1);
  });
});
