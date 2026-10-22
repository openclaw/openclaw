import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cryptoDigest from "../../infra/crypto-digest.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import type { OpenClawSkillMetadata } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import * as frontmatter from "./frontmatter.js";
import { writeSkillFixture, useLoadingFixture } from "./loading.test-support.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const promptFor = async (
  dir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): Promise<string> => (await buildSkillSnapshot(dir, opts)).prompt;

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

const fixture = useLoadingFixture("openclaw-skills-prompt-suite-");

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function logger(level: "info" | "warn" = "info", consoleStyle: "json" | "compact" = "json") {
  setLoggerOverride({ level: "silent", consoleLevel: level, consoleStyle });
  const log = vi.fn();
  const warn = vi.fn();
  loggingState.rawConsole = { log, info: log, warn, error: vi.fn() };
  return level === "warn" ? warn : log;
}

const entry = (name: string, metadata: OpenClawSkillMetadata) => ({
  ...createFixtureSkillEntry(name, { source: "project" }),
  metadata,
});

const skill = (dir: string, name: string, description: string, body?: string) =>
  writeSkillFixture(path.join(dir, name), name, description, { body });

const sourceOptions = (root: string, bundledSkillsDir: string, executionWorkspaceDir?: string) => ({
  bundledSkillsDir,
  executionWorkspaceDir,
  managedSkillsDir: path.join(root, "managed"),
  pluginSkillsDir: path.join(root, "plugins"),
});

function refresh(dir: string, options: Parameters<typeof loadWorkspaceSkills>[1]) {
  bumpSkillsSnapshotVersion({ dir, reason: "watch" });
  return loadWorkspaceSkills(dir, options);
}

describe("promptFor", () => {
  it("aggregates 30 differing skills per root pair and stays silent on unchanged refresh", async () => {
    const root = await fixture.createDir("aggregate-collisions");
    const info = logger();
    const warn = vi.mocked(loggingState.rawConsole!.warn);
    const cases = [];
    for (let pair = 0; pair < 4; pair++) {
      const dir = path.join(root, "worktrees", `repo-${pair}`, "branch");
      const executionWorkspaceDir = path.join(root, "projects", `repo-${pair}`, "checkout");
      for (const [workspace, body] of [
        [dir, "Branch instructions"],
        [executionWorkspaceDir, "Project instructions"],
      ] as const) {
        for (let index = 0; index < 30; index++) {
          const name = `pair-${pair}-skill-${String(index).padStart(2, "0")}`;
          await skill(path.join(workspace, ".agents", "skills", "group"), name, name, body);
        }
      }
      cases.push({
        dir,
        options: {
          ...sourceOptions(root, "", executionWorkspaceDir),
          executionWorkspaceDir,
          config: { worktreeRoot: path.join(root, "worktrees") },
        },
      });
    }
    for (const { dir, options } of cases) {
      expect(loadWorkspaceSkills(dir, options)).toHaveLength(30);
    }
    const reports = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(info).not.toHaveBeenCalled();
    info.mockClear();
    warn.mockClear();
    for (const { dir, options } of cases) {
      refresh(dir, options);
    }
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(reports).toHaveLength(4);
    for (const [pair, { dir, options }] of cases.entries()) {
      expect(reports[pair]).toMatchObject({
        level: "warn",
        winnerRoot: path.join(dir, ".agents", "skills"),
        loserRoot: path.join(options.executionWorkspaceDir, ".agents", "skills"),
        skillCount: 30,
        skills: [0, 1, 2].map((n) => `pair-${pair}-skill-0${n}`).concat("+27 more"),
      });
    }
    for (const { dir, options } of cases) {
      loadWorkspaceSkills(options.executionWorkspaceDir, {
        ...options,
        executionWorkspaceDir: dir,
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
      const dir = await fixture.createDir("precedence");
      const config = {
        agents: { entries: { main: { agentDir: path.join(dir, ".agent") } } },
      };
      const locations = {
        workspace: path.join(dir, "skills"),
        managed: path.join(dir, ".managed"),
        workshop: resolveWorkshopSkillsDir(config, "main"),
        bundled: path.join(dir, ".bundled"),
        extra: path.join(dir, ".extra"),
        execution: path.join(dir, ".extra", "skills"),
        extra0: path.join(dir, "root-0"),
        extra1: path.join(dir, "root-1"),
        extra2: path.join(dir, "root-2"),
      };
      const description = (root: string) => `${root} version`;
      const name = "demo-skill";
      for (const root of roots) {
        await skill(locations[root], name, description(root));
      }
      const info = logger("info", compact ? "compact" : "json");
      const extraDirs = roots
        .filter((root) => root.startsWith("extra"))
        .map((root) => locations[root]);
      const options = {
        config: { ...config, skills: { load: { extraDirs } } },
        agentId: "main",
        managedSkillsDir: locations.managed,
        bundledSkillsDir: locations.bundled,
        pluginSkillsDir: path.join(dir, ".plugins"),
        executionWorkspaceDir: roots.some((root) => root === "execution")
          ? path.dirname(locations.execution)
          : undefined,
      };
      await withEnvAsync({ HOME: dir, PATH: "" }, async () => {
        const entries = loadWorkspaceSkills(dir, options);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.skill).toMatchObject({
          description: description(winner),
          source,
          filePath: path.join(locations[winner], name, "SKILL.md"),
        });
        const prompt = await promptFor(dir, options);
        expect(prompt).toContain(description(winner));
        expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
        for (const root of roots) {
          if (root !== winner) {
            expect(prompt).not.toContain(description(root));
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
        refresh(dir, options);
        expect(info).toHaveBeenCalledTimes(roots.length - 1);
      });
    },
  );

  it("silently reuses identical skill content across copies and rebuilds without changing winners", async () => {
    const root = await fixture.createDir("identical-content");
    const bundledSkillsDir = path.join(root, "bundled");
    const name = "identical-collision";
    await skill(bundledSkillsDir, name, "Shared facts");
    const raw = await fs.readFile(path.join(bundledSkillsDir, name, "SKILL.md"), "utf8");
    const warn = logger("warn");
    const hash = vi.spyOn(cryptoDigest, "sha256Hex");
    const parse = vi.spyOn(frontmatter, "parseSkillFrontmatter");
    try {
      for (const id of ["first", "second"]) {
        const dir = path.join(root, id);
        const executionWorkspaceDir = path.join(root, `${id}-execution`);
        for (const copy of [
          path.join(dir, "skills", name),
          path.join(dir, ".agents", "skills", name),
        ]) {
          await fs.mkdir(copy, { recursive: true });
          await fs.writeFile(path.join(copy, "SKILL.md"), raw);
        }
        await fs.mkdir(executionWorkspaceDir, { recursive: true });
        await fs.symlink(
          path.join(dir, "skills"),
          path.join(executionWorkspaceDir, "skills"),
          process.platform === "win32" ? "junction" : "dir",
        );
        const options = sourceOptions(root, bundledSkillsDir, executionWorkspaceDir);
        const first = loadWorkspaceSkills(dir, options);
        expect(first.filter((item) => item.skill.name === name)).toHaveLength(1);
        const prompt = await promptFor(dir, options);
        expect(refresh(dir, options)).toEqual(first);
        expect(await promptFor(dir, options)).toBe(prompt);
        expect(first.find((item) => item.skill.name === name)?.skill).toMatchObject({
          filePath: path.join(dir, "skills", name, "SKILL.md"),
          source: "openclaw-workspace",
          sourceInfo: { path: path.join(dir, "skills", name, "SKILL.md") },
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
    const root = await fixture.createDir("different-content");
    const bundledSkillsDir = path.join(root, "bundled");
    const name = "different-collision";
    await skill(bundledSkillsDir, name, "Shared metadata", "Bundled");
    const warn = logger("warn");
    for (const id of ["first", "second"]) {
      const dir = path.join(root, id);
      await skill(path.join(dir, "skills"), name, "Shared metadata", "Override");
      const options = { bundledSkillsDir, managedSkillsDir: path.join(root, "managed") };
      loadWorkspaceSkills(dir, options);
      refresh(dir, options);
      expect(warn).toHaveBeenCalledTimes(id === "first" ? 1 : 2);
    }
    const dir = path.join(root, "second");
    const skillDir = path.join(dir, "skills", name);
    const options = { bundledSkillsDir, managedSkillsDir: path.join(root, "managed") };
    for (const [description, body, count] of [
      ["Shared metadata", "Changed instructions", 3],
      ["Changed metadata", "Changed instructions", 4],
      ["Shared metadata", "Override", 5],
    ] as const) {
      await writeSkillFixture(skillDir, name, description, { body });
      refresh(dir, options);
      expect(warn).toHaveBeenCalledTimes(count);
    }
    // Membership changes update the same root-pair aggregate.
    for (const [base, description] of [
      [bundledSkillsDir, "Bundled"],
      [path.join(dir, "skills"), "Workspace"],
    ] as const) {
      await skill(base, "another-collision", description);
    }
    refresh(dir, options);
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
    await fs.rm(path.join(skillDir, "SKILL.md"));
    refresh(dir, options);
    expect(warn).toHaveBeenCalledTimes(7);
    expect(JSON.parse(String(warn.mock.calls[6]?.[0]))).toMatchObject({
      skillCount: 1,
      skills: ["another-collision"],
    });
    const remainingDir = path.join(dir, "skills", "another-collision");
    await fs.rm(path.join(remainingDir, "SKILL.md"));
    refresh(dir, options);
    expect(warn).toHaveBeenCalledTimes(7);
    // Retiring this pair must not replay the other workspace's unchanged collision.
    loadWorkspaceSkills(path.join(root, "first"), options);
    expect(warn).toHaveBeenCalledTimes(7);
    await writeSkillFixture(remainingDir, "another-collision", "Workspace");
    refresh(dir, options);
    expect(warn).toHaveBeenCalledTimes(8);
  });

  it("gates by bins, config, and always", async () => {
    const dir = await fixture.createDir("workspace");
    const entries = [
      entry("bin-skill", { requires: { bins: ["fakebin"] } }),
      entry("anybin-skill", { requires: { anyBins: ["missingbin", "fakebin"] } }),
      entry("config-skill", { requires: { config: ["browser.enabled"] } }),
      entry("always-skill", { always: true, requires: { env: ["MISSING"] } }),
      entry("env-skill", { requires: { env: ["ENV_KEY"] }, primaryEnv: "ENV_KEY" }),
    ];

    const managedSkillsDir = path.join(dir, ".managed");
    for (const available of [false, true]) {
      const prompt = await withEnvAsync({ HOME: dir, PATH: "" }, () =>
        promptFor(dir, {
          entries,
          managedSkillsDir,
          config: available
            ? {
                browser: { enabled: false },
                skills: { entries: { "env-skill": { apiKey: "ok" } } }, // pragma: allowlist secret
              }
            : undefined,
          eligibility: {
            remote: {
              platforms: ["linux"],
              hasBin: (bin: string) => available && bin === "fakebin",
              hasAnyBin: (bins: string[]) => available && bins.includes("fakebin"),
              note: "",
            },
          },
        }),
      );
      expect(entries.map((item) => prompt.includes(item.skill.name))).toEqual(
        available ? [true, true, false, true, true] : [false, false, true, true, false],
      );
    }
  });
  it.each(["config", "session"] as const)(
    "uses the canonical skillKey for %s disabling",
    async (surface) => {
      const dir = await fixture.createDir("workspace");
      const prompt = await withEnvAsync({ HOME: dir, PATH: "" }, () =>
        promptFor(dir, {
          entries: [entry("alias-skill", { skillKey: "alias" })],
          managedSkillsDir: path.join(dir, ".managed"),
          ...(surface === "config"
            ? { config: { skills: { entries: { alias: { enabled: false } } } } }
            : { skillFilter: ["alias-skill"], skillOverrides: { alias: false } }),
        }),
      );
      expect(prompt).not.toContain("alias-skill");
    },
  );
});
