// Workspace precedence tests cover precedence between workspace, plugin, and bundled skills.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as cryptoDigest from "../../infra/crypto-digest.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { OpenClawSkillMetadata, SkillEntry } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import * as frontmatter from "./frontmatter.js";
import { createSyntheticSourceInfo } from "./skill-contract.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const buildWorkspaceSkillsPrompt = async (
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): Promise<string> => (await buildSkillSnapshot(workspaceDir, opts)).prompt;

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

const fixtureSuite = createFixtureSuite("openclaw-skills-prompt-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

function captureJsonWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

function createSkillEntry(params: {
  name: string;
  description?: string;
  metadata?: OpenClawSkillMetadata;
}): SkillEntry {
  const filePath = `/skills/${params.name}/SKILL.md`;
  return {
    skill: {
      name: params.name,
      description: params.description ?? params.name,
      filePath,
      source: "project",
      baseDir: path.dirname(filePath),
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "project" }),
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: params.metadata,
  };
}

describe("buildWorkspaceSkillsPrompt", () => {
  it("prefers workspace skills over managed skills", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedSkillDir = path.join(managedDir, "demo-skill");
    const bundledSkillDir = path.join(bundledDir, "demo-skill");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: bundledSkillDir,
      name: "demo-skill",
      description: "Bundled version",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: managedSkillDir,
      name: "demo-skill",
      description: "Managed version",
      body: "# Managed\n",
    });
    await writeSkill({
      dir: workspaceSkillDir,
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = await withEnvAsync(
      { HOME: workspaceDir, PATH: "" },
      async () =>
        await buildWorkspaceSkillsPrompt(workspaceDir, {
          managedSkillsDir: managedDir,
          bundledSkillsDir: bundledDir,
        }),
    );

    expect(prompt).toContain("Workspace version");
    expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
  });

  it("loads Workshop skills below managed and above bundled", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workshop-precedence");
    const managedDir = path.join(workspaceDir, ".managed");
    const config = {
      agents: { entries: { main: { agentDir: path.join(workspaceDir, ".agent") } } },
    };
    const workshopDir = resolveWorkshopSkillsDir(config, "main");
    const bundledDir = path.join(workspaceDir, ".bundled");
    for (const [root, name, description] of [
      [managedDir, "managed-wins", "Managed version"],
      [workshopDir, "managed-wins", "Workshop version below managed"],
      [workshopDir, "workshop-wins", "Workshop version"],
      [bundledDir, "workshop-wins", "Bundled version below Workshop"],
    ] as const) {
      await writeSkill({ dir: path.join(root, name), name, description });
    }

    const entries = loadWorkspaceSkills(workspaceDir, {
      config,
      agentId: "main",
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    });

    expect(entries.find((entry) => entry.skill.name === "managed-wins")?.skill).toMatchObject({
      source: "openclaw-managed",
      description: "Managed version",
    });
    expect(entries.find((entry) => entry.skill.name === "workshop-wins")?.skill).toMatchObject({
      source: "openclaw-workshop",
      description: "Workshop version",
    });
  });

  it("keeps extraDirs below bundled precedence and reports the collision", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("extra-bundled-collision");
    const extraDir = path.join(workspaceDir, ".extra");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraSkillDir = path.join(extraDir, "demo-skill");
    const bundledSkillDir = path.join(bundledDir, "demo-skill");
    await writeSkill({
      dir: extraSkillDir,
      name: "demo-skill",
      description: "Extra version",
    });
    await writeSkill({
      dir: bundledSkillDir,
      name: "demo-skill",
      description: "Bundled version",
    });
    const warn = captureWarningLogger();

    const prompt = await withEnvAsync(
      { HOME: workspaceDir, PATH: "" },
      async () =>
        await buildWorkspaceSkillsPrompt(workspaceDir, {
          bundledSkillsDir: bundledDir,
          managedSkillsDir: path.join(workspaceDir, ".managed"),
          config: { skills: { load: { extraDirs: [extraDir] } } },
        }),
    );
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(prompt).toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
    expect(warningText).toContain('skill="demo-skill"');
    expect(warningText).toContain("winner=openclaw-bundled:~/.bundled/demo-skill/SKILL.md");
    expect(warningText).toContain("loser=openclaw-extra:~/.extra/demo-skill/SKILL.md");
  });

  it("reports execution-directory collisions while keeping workspace precedence", async () => {
    const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-workspace-collision");
    const executionWorkspaceDir = await fixtureSuite.createCaseDir("execution-workspace-collision");
    const workspaceSkillFile = path.join(agentWorkspaceDir, "skills", "demo-skill", "SKILL.md");
    const executionSkillFile = path.join(executionWorkspaceDir, "skills", "demo-skill", "SKILL.md");
    await writeSkill({
      dir: path.dirname(workspaceSkillFile),
      name: "demo-skill",
      description: "Workspace version",
    });
    await writeSkill({
      dir: path.dirname(executionSkillFile),
      name: "demo-skill",
      description: "Execution version",
    });
    const warn = captureJsonWarningLogger();

    const loadOptions = {
      agentWorkspaceDir,
      executionWorkspaceDir,
      managedSkillsDir: path.join(agentWorkspaceDir, ".managed"),
      bundledSkillsDir: "",
      pluginSkillsDir: path.join(agentWorkspaceDir, ".plugin-skills"),
    };
    const entries = loadWorkspaceSkills(agentWorkspaceDir, loadOptions);
    const warning = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;

    expect(entries.find((entry) => entry.skill.name === "demo-skill")?.skill.description).toBe(
      "Workspace version",
    );
    expect(warning).toMatchObject({
      message: "Skill precedence collision resolved.",
      skill: "demo-skill",
      winnerPath: workspaceSkillFile,
      loserPath: executionSkillFile,
    });

    loadWorkspaceSkills(agentWorkspaceDir, loadOptions);
    expect(warn).toHaveBeenCalledOnce();

    bumpSkillsSnapshotVersion({ workspaceDir: agentWorkspaceDir, reason: "watch" });
    loadWorkspaceSkills(agentWorkspaceDir, loadOptions);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not report execution-directory collisions for the same canonical skill file", async () => {
    const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-workspace-symlink");
    const executionWorkspaceDir = await fixtureSuite.createCaseDir("execution-workspace-symlink");
    const workspaceSkillsDir = path.join(agentWorkspaceDir, "skills");
    await writeSkill({
      dir: path.join(workspaceSkillsDir, "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
    });
    await fs.symlink(
      workspaceSkillsDir,
      path.join(executionWorkspaceDir, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const warn = captureWarningLogger();

    const entries = loadWorkspaceSkills(agentWorkspaceDir, {
      executionWorkspaceDir,
      managedSkillsDir: path.join(agentWorkspaceDir, ".managed"),
      bundledSkillsDir: "",
      pluginSkillsDir: path.join(agentWorkspaceDir, ".plugin-skills"),
    });

    expect(entries.filter((entry) => entry.skill.name === "demo-skill")).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("silently reuses identical skill content across copies and rebuilds without changing winners", async () => {
    const root = await fixtureSuite.createCaseDir("identical-content");
    const bundledSkillsDir = path.join(root, "bundled");
    const name = "identical-collision";
    await writeSkill({ dir: path.join(bundledSkillsDir, name), name, description: "Shared facts" });
    const raw = await fs.readFile(path.join(bundledSkillsDir, name, "SKILL.md"), "utf8");
    const warn = captureWarningLogger();
    const hash = vi.spyOn(cryptoDigest, "sha256Hex");
    const parse = vi.spyOn(frontmatter, "parseSkillFrontmatter");
    try {
      for (const id of ["first", "second"]) {
        const workspaceDir = path.join(root, id);
        const executionWorkspaceDir = path.join(root, `${id}-execution`);
        for (const dir of [
          path.join(workspaceDir, "skills", name),
          path.join(workspaceDir, ".agents", "skills", name),
          path.join(executionWorkspaceDir, "skills", name),
        ]) {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "SKILL.md"), raw);
        }
        const options = {
          bundledSkillsDir,
          executionWorkspaceDir,
          managedSkillsDir: path.join(root, "managed"),
          pluginSkillsDir: path.join(root, "plugins"),
        };
        const first = loadWorkspaceSkills(workspaceDir, options);
        const prompt = (await buildSkillSnapshot(workspaceDir, options)).prompt;
        bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
        expect(loadWorkspaceSkills(workspaceDir, options)).toEqual(first);
        expect((await buildSkillSnapshot(workspaceDir, options)).prompt).toBe(prompt);
        expect(first.find((entry) => entry.skill.name === name)?.skill).toMatchObject({
          filePath: path.join(workspaceDir, "skills", name, "SKILL.md"),
          source: "openclaw-workspace",
          sourceInfo: { path: path.join(workspaceDir, "skills", name, "SKILL.md") },
        });
      }
      expect(hash.mock.calls.filter(([input]) => input === raw)).toHaveLength(1);
      expect(parse.mock.calls.filter(([input]) => input === raw)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
      parse.mockRestore();
    }
  });

  it("reports different collision content once across workspaces and reports changed content again", async () => {
    const root = await fixtureSuite.createCaseDir("different-content");
    const bundledSkillsDir = path.join(root, "bundled");
    const name = "different-collision";
    await writeSkill({
      dir: path.join(bundledSkillsDir, name),
      name,
      description: "Shared metadata",
      body: "Bundled",
    });
    const warn = captureJsonWarningLogger();
    for (const id of ["first", "second"]) {
      const workspaceDir = path.join(root, id);
      const dir = path.join(workspaceDir, "skills", name);
      await writeSkill({ dir, name, description: "Shared metadata", body: "Override" });
      const options = { bundledSkillsDir, managedSkillsDir: path.join(root, "managed") };
      loadWorkspaceSkills(workspaceDir, options);
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      loadWorkspaceSkills(workspaceDir, options);
      expect(warn).toHaveBeenCalledOnce();
    }
    const workspaceDir = path.join(root, "second");
    const dir = path.join(workspaceDir, "skills", name);
    const options = { bundledSkillsDir, managedSkillsDir: path.join(root, "managed") };
    for (const [description, body, count] of [
      ["Shared metadata", "Changed instructions", 2],
      ["Changed metadata", "Changed instructions", 3],
      ["Shared metadata", "Override", 3],
    ] as const) {
      await writeSkill({ dir, name, description, body });
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      loadWorkspaceSkills(workspaceDir, options);
      expect(warn).toHaveBeenCalledTimes(count);
    }
    // A new collision must not replay the existing pair.
    for (const [base, description] of [
      [bundledSkillsDir, "Bundled"],
      [path.join(workspaceDir, "skills"), "Workspace"],
    ] as const) {
      await writeSkill({
        dir: path.join(base, "another-collision"),
        name: "another-collision",
        description,
      });
    }
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    loadWorkspaceSkills(workspaceDir, options);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      message: "Skill precedence collision resolved.",
      skill: name,
      winnerPath: path.join(root, "first", "skills", name, "SKILL.md"),
      loserPath: path.join(bundledSkillsDir, name, "SKILL.md"),
    });
  });
  it("gates by bins, config, and always", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const entries = [
      createSkillEntry({
        name: "bin-skill",
        description: "Needs a bin",
        metadata: { requires: { bins: ["fakebin"] } },
      }),
      createSkillEntry({
        name: "anybin-skill",
        description: "Needs any bin",
        metadata: { requires: { anyBins: ["missingbin", "fakebin"] } },
      }),
      createSkillEntry({
        name: "config-skill",
        description: "Needs config",
        metadata: { requires: { config: ["browser.enabled"] } },
      }),
      createSkillEntry({
        name: "always-skill",
        description: "Always on",
        metadata: { always: true, requires: { env: ["MISSING"] } },
      }),
      createSkillEntry({
        name: "env-skill",
        description: "Needs env",
        metadata: { requires: { env: ["ENV_KEY"] }, primaryEnv: "ENV_KEY" },
      }),
    ];

    const managedSkillsDir = path.join(workspaceDir, ".managed");
    const defaultPrompt = await withEnvAsync(
      { HOME: workspaceDir, PATH: "" },
      async () =>
        await buildWorkspaceSkillsPrompt(workspaceDir, {
          entries,
          managedSkillsDir,
          eligibility: {
            remote: {
              platforms: ["linux"],
              hasBin: () => false,
              hasAnyBin: () => false,
              note: "",
            },
          },
        }),
    );
    expect(defaultPrompt).toContain("always-skill");
    expect(defaultPrompt).toContain("config-skill");
    expect(defaultPrompt).not.toContain("bin-skill");
    expect(defaultPrompt).not.toContain("anybin-skill");
    expect(defaultPrompt).not.toContain("env-skill");

    const gatedPrompt = await withEnvAsync(
      { HOME: workspaceDir, PATH: "" },
      async () =>
        await buildWorkspaceSkillsPrompt(workspaceDir, {
          entries,
          managedSkillsDir,
          config: {
            browser: { enabled: false },
            skills: { entries: { "env-skill": { apiKey: "ok" } } }, // pragma: allowlist secret
          },
          eligibility: {
            remote: {
              platforms: ["linux"],
              hasBin: (bin: string) => bin === "fakebin",
              hasAnyBin: (bins: string[]) => bins.includes("fakebin"),
              note: "",
            },
          },
        }),
    );
    expect(gatedPrompt).toContain("bin-skill");
    expect(gatedPrompt).toContain("anybin-skill");
    expect(gatedPrompt).toContain("env-skill");
    expect(gatedPrompt).toContain("always-skill");
    expect(gatedPrompt).not.toContain("config-skill");
  });
  it("uses skillKey for config lookups", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const prompt = await withEnvAsync(
      { HOME: workspaceDir, PATH: "" },
      async () =>
        await buildWorkspaceSkillsPrompt(workspaceDir, {
          entries: [
            createSkillEntry({
              name: "alias-skill",
              description: "Uses skillKey",
              metadata: { skillKey: "alias" },
            }),
          ],
          managedSkillsDir: path.join(workspaceDir, ".managed"),
          config: { skills: { entries: { alias: { enabled: false } } } },
        }),
    );
    expect(prompt).not.toContain("alias-skill");
  });

  it("uses the canonical skillKey for session overrides while filtering agents by skill name", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const prompt = await withEnvAsync(
      { HOME: workspaceDir, PATH: "" },
      async () =>
        await buildWorkspaceSkillsPrompt(workspaceDir, {
          entries: [
            createSkillEntry({
              name: "alias-skill",
              metadata: { skillKey: "canonical-alias" },
            }),
          ],
          managedSkillsDir: path.join(workspaceDir, ".managed"),
          skillFilter: ["alias-skill"],
          skillOverrides: { "canonical-alias": false },
        }),
    );

    expect(prompt).not.toContain("alias-skill");
  });
});
