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

function captureLogger(level: "info" | "warn" = "info", consoleStyle: "json" | "compact" = "json") {
  setLoggerOverride({ level: "silent", consoleLevel: level, consoleStyle });
  const log = vi.fn();
  const warn = vi.fn();
  loggingState.rawConsole = { log, info: log, warn, error: vi.fn() };
  return level === "warn" ? warn : log;
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
  it("aggregates 30 differing skills per root pair and stays silent on unchanged refresh", async () => {
    const root = await fixtureSuite.createCaseDir("aggregate-collisions");
    const info = captureLogger();
    const warn = vi.mocked(loggingState.rawConsole!.warn);
    const cases = [];
    for (let pair = 0; pair < 4; pair++) {
      const workspaceDir = path.join(root, "worktrees", `repo-${pair}`, "branch");
      const executionWorkspaceDir = path.join(root, "projects", `repo-${pair}`, "checkout");
      for (const [workspace, body] of [
        [workspaceDir, "Branch instructions"],
        [executionWorkspaceDir, "Project instructions"],
      ] as const) {
        for (let index = 0; index < 30; index++) {
          const name = `pair-${pair}-skill-${String(index).padStart(2, "0")}`;
          await writeSkill({
            dir: path.join(workspace, ".agents", "skills", "group", name),
            name,
            description: name,
            body,
          });
        }
      }
      cases.push({
        workspaceDir,
        options: {
          executionWorkspaceDir,
          bundledSkillsDir: "",
          managedSkillsDir: path.join(root, "managed"),
          pluginSkillsDir: path.join(root, "plugins"),
          config: { worktreeRoot: path.join(root, "worktrees") },
        },
      });
    }
    for (const { workspaceDir, options } of cases) {
      expect(loadWorkspaceSkills(workspaceDir, options)).toHaveLength(30);
    }
    const initialLines = info.mock.calls.length + warn.mock.calls.length;
    const reports = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(info).not.toHaveBeenCalled();
    info.mockClear();
    warn.mockClear();
    for (const { workspaceDir, options } of cases) {
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      loadWorkspaceSkills(workspaceDir, options);
    }
    const refreshLines = info.mock.calls.length + warn.mock.calls.length;
    console.log(
      `4 root pairs x 30 differing skills: initial=${initialLines}, refresh=${refreshLines}`,
    );
    expect(initialLines).toBe(4);
    expect(refreshLines).toBe(0);
    expect(reports).toHaveLength(4);
    for (const [pair, { workspaceDir, options }] of cases.entries()) {
      expect(reports[pair]).toMatchObject({
        level: "warn",
        winnerRoot: path.join(workspaceDir, ".agents", "skills"),
        loserRoot: path.join(options.executionWorkspaceDir, ".agents", "skills"),
        skillCount: 30,
        skills: [
          `pair-${pair}-skill-00`,
          `pair-${pair}-skill-01`,
          `pair-${pair}-skill-02`,
          "+27 more",
        ],
      });
    }
    for (const { workspaceDir, options } of cases) {
      loadWorkspaceSkills(options.executionWorkspaceDir, {
        ...options,
        executionWorkspaceDir: workspaceDir,
      });
    }
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(4);
  });

  it.each([
    [["bundled", "managed", "workspace"], "workspace", "openclaw-workspace", false],
    [["workshop", "managed"], "managed", "openclaw-managed", false],
    [["bundled", "workshop"], "workshop", "openclaw-workshop", false],
    [["extra", "bundled"], "bundled", "openclaw-bundled", true],
    [["execution", "bundled"], "bundled", "openclaw-bundled", true],
    [["execution", "workspace"], "workspace", "openclaw-workspace", false],
    [["extra0", "extra1", "extra2"], "extra2", "openclaw-extra", false],
  ] as const)(
    "resolves %j collisions in favor of %s without replaying reports",
    async (roots, winner, source, compact) => {
      const workspaceDir = await fixtureSuite.createCaseDir("precedence");
      const config = {
        agents: { entries: { main: { agentDir: path.join(workspaceDir, ".agent") } } },
      };
      const locations = {
        workspace: path.join(workspaceDir, "skills"),
        managed: path.join(workspaceDir, ".managed"),
        workshop: resolveWorkshopSkillsDir(config, "main"),
        bundled: path.join(workspaceDir, ".bundled"),
        extra: path.join(workspaceDir, ".extra"),
        execution: path.join(workspaceDir, ".extra", "skills"),
        extra0: path.join(workspaceDir, "root-0"),
        extra1: path.join(workspaceDir, "root-1"),
        extra2: path.join(workspaceDir, "root-2"),
      };
      const descriptions = {
        workspace: "Workspace version",
        managed: "Managed version",
        workshop: "Workshop version",
        bundled: "Bundled version",
        extra: "Extra version",
        execution: "Execution version",
        extra0: "Variant 0",
        extra1: "Variant 1",
        extra2: "Variant 2",
      };
      const name = "demo-skill";
      for (const root of roots) {
        await writeSkill({
          dir: path.join(locations[root], name),
          name,
          description: descriptions[root],
        });
      }
      const info = captureLogger("info", compact ? "compact" : "json");
      const options = {
        config: {
          ...config,
          skills: {
            load: {
              extraDirs: roots
                .filter((root) => root.startsWith("extra"))
                .map((root) => locations[root]),
            },
          },
        },
        agentId: "main",
        managedSkillsDir: locations.managed,
        bundledSkillsDir: locations.bundled,
        pluginSkillsDir: path.join(workspaceDir, ".plugins"),
        executionWorkspaceDir: roots.some((root) => root === "execution")
          ? path.dirname(locations.execution)
          : undefined,
      };
      await withEnvAsync({ HOME: workspaceDir, PATH: "" }, async () => {
        const entries = loadWorkspaceSkills(workspaceDir, options);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.skill).toMatchObject({
          description: descriptions[winner],
          source,
          filePath: path.join(locations[winner], name, "SKILL.md"),
        });
        const prompt = await buildWorkspaceSkillsPrompt(workspaceDir, options);
        expect(prompt).toContain(descriptions[winner]);
        expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
        for (const root of roots) {
          if (root !== winner) {
            expect(prompt).not.toContain(descriptions[root]);
          }
        }
        expect(info).toHaveBeenCalledTimes(roots.length - 1);
        expect(loggingState.rawConsole!.warn).not.toHaveBeenCalled();
        if (compact) {
          expect(info.mock.calls.flat().map(String).join("\n")).toContain(
            `~/.bundled shadows 1 skills from ~/.extra${roots[0] === "execution" ? "/skills" : ""} (demo-skill)`,
          );
        } else {
          expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
            message: "Skill precedence collisions resolved.",
            level: "info",
            skillCount: 1,
            skills: [name],
            winnerRoot: locations[roots[1]],
            loserRoot: locations[roots[0]],
          });
        }
        bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
        loadWorkspaceSkills(workspaceDir, options);
        expect(info).toHaveBeenCalledTimes(roots.length - 1);
      });
    },
  );

  it("silently reuses identical skill content across copies and rebuilds without changing winners", async () => {
    const root = await fixtureSuite.createCaseDir("identical-content");
    const bundledSkillsDir = path.join(root, "bundled");
    const name = "identical-collision";
    await writeSkill({ dir: path.join(bundledSkillsDir, name), name, description: "Shared facts" });
    const raw = await fs.readFile(path.join(bundledSkillsDir, name, "SKILL.md"), "utf8");
    const warn = captureLogger("warn");
    const hash = vi.spyOn(cryptoDigest, "sha256Hex");
    const parse = vi.spyOn(frontmatter, "parseSkillFrontmatter");
    try {
      for (const id of ["first", "second"]) {
        const workspaceDir = path.join(root, id);
        const executionWorkspaceDir = path.join(root, `${id}-execution`);
        for (const dir of [
          path.join(workspaceDir, "skills", name),
          path.join(workspaceDir, ".agents", "skills", name),
        ]) {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "SKILL.md"), raw);
        }
        await fs.mkdir(executionWorkspaceDir, { recursive: true });
        await fs.symlink(
          path.join(workspaceDir, "skills"),
          path.join(executionWorkspaceDir, "skills"),
          process.platform === "win32" ? "junction" : "dir",
        );
        const options = {
          bundledSkillsDir,
          executionWorkspaceDir,
          managedSkillsDir: path.join(root, "managed"),
          pluginSkillsDir: path.join(root, "plugins"),
        };
        const first = loadWorkspaceSkills(workspaceDir, options);
        expect(first.filter((entry) => entry.skill.name === name)).toHaveLength(1);
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

  it("reports each root pair once and reports changed aggregate content and membership again", async () => {
    const root = await fixtureSuite.createCaseDir("different-content");
    const bundledSkillsDir = path.join(root, "bundled");
    const name = "different-collision";
    await writeSkill({
      dir: path.join(bundledSkillsDir, name),
      name,
      description: "Shared metadata",
      body: "Bundled",
    });
    const warn = captureLogger("warn");
    for (const id of ["first", "second"]) {
      const workspaceDir = path.join(root, id);
      const dir = path.join(workspaceDir, "skills", name);
      await writeSkill({ dir, name, description: "Shared metadata", body: "Override" });
      const options = { bundledSkillsDir, managedSkillsDir: path.join(root, "managed") };
      loadWorkspaceSkills(workspaceDir, options);
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      loadWorkspaceSkills(workspaceDir, options);
      expect(warn).toHaveBeenCalledTimes(id === "first" ? 1 : 2);
    }
    const workspaceDir = path.join(root, "second");
    const dir = path.join(workspaceDir, "skills", name);
    const options = { bundledSkillsDir, managedSkillsDir: path.join(root, "managed") };
    for (const [description, body, count] of [
      ["Shared metadata", "Changed instructions", 3],
      ["Changed metadata", "Changed instructions", 4],
      ["Shared metadata", "Override", 5],
    ] as const) {
      await writeSkill({ dir, name, description, body });
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      loadWorkspaceSkills(workspaceDir, options);
      expect(warn).toHaveBeenCalledTimes(count);
    }
    // Membership changes update the same root-pair aggregate.
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
    expect(warn).toHaveBeenCalledTimes(6);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      message: "Skill precedence collisions resolved.",
      level: "warn",
      skillCount: 1,
      skills: [name],
      winnerRoot: path.join(root, "first", "skills"),
      loserRoot: bundledSkillsDir,
    });
    expect(JSON.parse(String(warn.mock.calls[5]?.[0]))).toMatchObject({ skillCount: 2 });
    await fs.rm(path.join(dir, "SKILL.md"));
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    loadWorkspaceSkills(workspaceDir, options);
    expect(warn).toHaveBeenCalledTimes(7);
    expect(JSON.parse(String(warn.mock.calls[6]?.[0]))).toMatchObject({
      skillCount: 1,
      skills: ["another-collision"],
    });
    const remainingDir = path.join(workspaceDir, "skills", "another-collision");
    await fs.rm(path.join(remainingDir, "SKILL.md"));
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    loadWorkspaceSkills(workspaceDir, options);
    expect(warn).toHaveBeenCalledTimes(7);
    // Retiring this pair must not replay the other workspace's unchanged collision.
    loadWorkspaceSkills(path.join(root, "first"), options);
    expect(warn).toHaveBeenCalledTimes(7);
    await writeSkill({ dir: remainingDir, name: "another-collision", description: "Workspace" });
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    loadWorkspaceSkills(workspaceDir, options);
    expect(warn).toHaveBeenCalledTimes(8);
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
  it.each(["config", "session"] as const)(
    "uses the canonical skillKey for %s disabling",
    async (surface) => {
      const workspaceDir = await fixtureSuite.createCaseDir("workspace");
      const prompt = await withEnvAsync({ HOME: workspaceDir, PATH: "" }, () =>
        buildWorkspaceSkillsPrompt(workspaceDir, {
          entries: [createSkillEntry({ name: "alias-skill", metadata: { skillKey: "alias" } })],
          managedSkillsDir: path.join(workspaceDir, ".managed"),
          ...(surface === "config"
            ? { config: { skills: { entries: { alias: { enabled: false } } } } }
            : { skillFilter: ["alias-skill"], skillOverrides: { alias: false } }),
        }),
      );
      expect(prompt).not.toContain("alias-skill");
    },
  );
});
