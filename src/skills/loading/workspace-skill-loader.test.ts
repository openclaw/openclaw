import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import type {
  PluginManifestRecord,
  PluginManifestRegistry,
} from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../../plugins/plugin-metadata.test-support.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import type { OpenClawSkillMetadata } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  writeSkillFixture,
  useLoadingFixture,
  captureWarningLogger,
} from "./loading.test-support.js";
import {
  loadVisibleSkills,
  loadWorkspaceSkills,
  prepareWorkspaceSkills,
  resolveWorkspaceSkillPromptEntries,
} from "./workspace-skill-loader.js";

// mock-isolation: discovery uses synthetic workspace manifests without the installed plugin registry.
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: (params: { workspaceDir?: string }) =>
    createWorkspacePluginRegistry(params.workspaceDir ?? ""),
}));

const names = (entries: Awaited<ReturnType<typeof prepareWorkspaceSkills>>) =>
  entries.map((entry) => entry.skill.name);
const named = (dir: string, name: string, description: string) =>
  writeSkillFixture(path.join(dir, name), name, description);
async function rawSkill(dir: string, content: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fs.writeFile(file, content, "utf8");
  return file;
}

describe("prompt asynchronous binary preparation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setActiveDegradedSecretOwners([]);
  });

  async function fixture(skills: Array<[string, OpenClawSkillMetadata]>) {
    const dir = await newDir();
    const binDir = path.join(dir, "bin");
    const bundled = path.join(dir, ".bundled");
    await fs.mkdir(binDir);
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("PATHEXT", "");
    vi.stubEnv("OPENCLAW_TEST_PROBE_KEY", "");
    for (const [name, meta] of skills) {
      await writeSkillFixture(
        path.join(name === "bundled" ? bundled : path.join(dir, "skills"), name),
        name,
        name,
        { metadata: JSON.stringify({ openclaw: meta }) },
      );
    }
    const config: OpenClawConfig = { plugins: { enabled: false }, browser: { enabled: false } };
    const options = {
      config,
      eligibility: {},
      bundledSkillsDir: bundled,
      managedSkillsDir: path.join(dir, ".managed"),
      pluginMetadataSnapshot: metadata(dir, config, { plugins: [], diagnostics: [] }),
    };
    const resolve = async (assertCurrent?: () => void) =>
      names(
        (await resolveWorkspaceSkillPromptEntries(dir, { ...options, assertCurrent })).eligible,
      );
    return { binDir, config, resolve };
  }

  function degrade(name: string) {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: `skill:${name}`,
        state: "unavailable",
        paths: [`skills.entries.${name}.apiKey`],
        refKeys: ["env:default:OPENCLAW_TEST_PROBE_KEY"],
        reason: "fixture secret unavailable",
      },
    ]);
  }

  it("skips probes for excluded/always skills and detects new binaries", async () => {
    const { binDir, config, resolve } = await fixture([
      ["env", { requires: { bins: ["env-tool"], env: ["OPENCLAW_TEST_PROBE_KEY"] } }],
      ["config", { requires: { anyBins: ["config-tool"], config: ["browser.enabled"] } }],
      ["disabled", { always: true, requires: { bins: ["disabled-tool"] } }],
      ["secret", { always: true, requires: { bins: ["secret-tool"] } }],
      ["os", { always: true, os: ["unsupported-fixture-os"], requires: { bins: ["os-tool"] } }],
      ["bundled", { requires: { bins: ["bundled-tool"] } }],
      ["always", { always: true, requires: { bins: ["always-tool"] } }],
      ["ordinary", { requires: { anyBins: ["missing-tool", "installed-tool"] } }],
    ]);
    config.skills = { allowBundled: ["other"], entries: { disabled: { enabled: false } } };
    degrade("secret");
    const access = vi.spyOn(fs, "access");
    const expectProbes = () =>
      expect(access.mock.calls.map(([file]) => path.basename(String(file))).toSorted()).toEqual([
        "installed-tool",
        "missing-tool",
      ]);
    expect(await Promise.all([resolve(), resolve()])).toEqual([["always"], ["always"]]);
    expectProbes();
    await fs.writeFile(path.join(binDir, "installed-tool"), "fixture", { mode: 0o755 });
    access.mockClear();
    expect(await resolve()).toEqual(["always", "ordinary"]);
    expectProbes();
    access.mockClear();
    expect(await resolve()).toEqual(["always", "ordinary"]);
    expectProbes();
  });

  it("isolates concurrent preparation cancellation", async () => {
    const { binDir, resolve } = await fixture([
      ["ordinary", { requires: { bins: ["installed-tool"] } }],
    ]);
    const executable = path.join(binDir, "installed-tool");
    await fs.writeFile(executable, "fixture", { mode: 0o755 });
    const entered = createDeferred();
    const release = createDeferred();
    const actualAccess = fs.access;
    vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (args[0] === executable) {
        entered.resolve();
        await release.promise;
      }
      return actualAccess(...args);
    });
    const cancellation = new Error("fixture caller retired");
    let canceled = false;
    const results = Promise.allSettled([
      resolve(() => {
        if (canceled) {
          throw cancellation;
        }
      }),
      resolve(),
    ]);
    try {
      await entered.promise;
      canceled = true;
    } finally {
      release.resolve();
    }
    expect(await results).toEqual([
      { status: "rejected", reason: cancellation },
      { status: "fulfilled", value: ["ordinary"] },
    ]);
  });
});

const fixture = useLoadingFixture("openclaw-skills-workspace-skill-loader-", true);

function createWorkspacePluginRegistry(dir: string): PluginManifestRegistry {
  const extensionsRoot = path.join(dir, ".openclaw", "extensions");
  const plugins: PluginManifestRecord[] = [];
  for (const id of ["workspace-skills", "browser"]) {
    const rootDir = path.join(extensionsRoot, id);
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    if (!fsSync.existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as {
      id?: string;
      enabledByDefault?: boolean;
      skills?: string[];
      configSchema?: Record<string, unknown>;
    };
    plugins.push(
      createPluginManifestRecordFixture({
        id: manifest.id ?? id,
        origin: id === "browser" ? "bundled" : "workspace",
        enabledByDefault: manifest.enabledByDefault,
        legacyPluginIds: [],
        kind: [],
        skills: manifest.skills ?? ["./skills"],
        rootDir,
        source: rootDir,
        manifestPath,
        configSchema: manifest.configSchema,
      }),
    );
  }
  return { plugins, diagnostics: [] };
}

function metadata(
  dir: string,
  config?: OpenClawConfig,
  records = createWorkspacePluginRegistry(dir),
): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const snapshot = createPluginMetadataSnapshotFixture(records);
  return {
    ...snapshot,
    policyHash,
    workspaceDir: dir,
    index: { ...snapshot.index, policyHash },
    registryIndex: { ...snapshot.registryIndex, policyHash },
    normalizePluginId: (pluginId) => pluginId,
  };
}

const newDir = () => fixture.createDir();

function load(dir: string, opts?: Parameters<typeof loadWorkspaceSkills>[1]) {
  return loadWorkspaceSkills(dir, {
    ...isolated(dir),
    ...opts,
    pluginMetadataSnapshot: opts?.pluginMetadataSnapshot ?? metadata(dir, opts?.config),
  });
}

const isolated = (dir: string) => ({
  managedSkillsDir: path.join(dir, ".managed"),
  bundledSkillsDir: "",
  pluginSkillsDir: path.join(dir, ".plugin-skills"),
});
const write = async (dir: string, ...skills: Array<[string, string]>) => {
  for (const [name, description] of skills) {
    await named(path.join(dir, "skills"), name, description);
  }
};
const plugin = (dir: string, id: string, name: string) => {
  const root = path.join(dir, ".openclaw", "extensions", id);
  return writePluginWithSkill({
    pluginRoot: root,
    pluginId: id,
    skillId: name,
    skillDescription: `${id} fixture`,
  }).then(() => path.join(root, "skills", name, "SKILL.md"));
};

afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.useRealTimers();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

describe("loadWorkspaceSkills", () => {
  it("addresses a bundled skill despite workspace collisions and unrelated selections", async () => {
    const dir = await newDir();
    const bundledSkillsDir = path.join(dir, ".bundled");
    const executionWorkspaceDir = await newDir();
    await named(bundledSkillsDir, "control-ui", "Bundled Control UI");
    await write(dir, ["control-ui", "Workspace replacement"]);
    await write(executionWorkspaceDir, ["execution-only", "Unrelated execution skill"]);
    const options = { config: {}, bundledSkillsDir, managedSkillsDir: path.join(dir, ".managed") };
    const visible = loadVisibleSkills(dir, options);
    const entries = await prepareWorkspaceSkills(dir, {
      ...options,
      bundledSkillName: "control-ui",
      executionWorkspaceDir,
      librarySelections: [
        {
          skillId: "unavailable-library-skill",
          revision: "unavailable-revision",
          name: "unrelated-library-skill",
          ownerProfileId: "fixture-owner",
        },
      ],
      eligibility: {},
    });
    expect(visible.find((entry) => entry.skill.name === "control-ui")?.skill.source).toBe(
      "openclaw-workspace",
    );
    expect(names(entries)).toEqual(["control-ui"]);
    expect(entries[0]?.skill).toMatchObject({
      source: "openclaw-bundled",
      filePath: await fs.realpath(path.join(bundledSkillsDir, "control-ui", "SKILL.md")),
    });
  });

  it("isolates each agent's Workshop skills", async () => {
    const root = await newDir();
    const dir = path.join(root, "workspace");
    const config = {
      agents: {
        entries: {
          alpha: { agentDir: path.join(root, "alpha"), workspace: dir },
          beta: { agentDir: path.join(root, "beta"), workspace: dir },
        },
      },
    } satisfies OpenClawConfig;
    for (const agentId of ["alpha", "beta"]) {
      await named(resolveWorkshopSkillsDir(config, agentId), `${agentId}-only`, `${agentId} skill`);
    }
    for (const agentId of ["alpha", "beta"]) {
      const skills = names(loadWorkspaceSkills(dir, { config, agentId }));
      expect(skills).toContain(`${agentId}-only`);
      expect(skills).not.toContain(`${agentId === "alpha" ? "beta" : "alpha"}-only`);
    }
  });
  it("shares discovery across execution scopes until automatic refresh", async ({ signal }) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(0);
    const dir = await newDir();
    const executions = [await newDir(), await newDir()];
    await write(dir, ["cached-skill", "Agent skill"]);
    for (const execution of executions) {
      await write(
        execution,
        ["cached-skill", "Losing execution copy"],
        ["execution-skill", execution],
      );
    }
    const options = { ...isolated(dir), config: { plugins: { enabled: false } } };
    const prepare = (executionWorkspaceDir?: string, skillFilter?: string[]) =>
      prepareWorkspaceSkills(dir, { ...options, executionWorkspaceDir, skillFilter });
    const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
    const scan = async () => {
      tasks.mockClear();
      let settledTasks = 0;
      for (let elapsed = 0; elapsed < 30 * 60_000 + 50; elapsed += 60_000) {
        await vi.advanceTimersByTimeAsync(Math.min(60_000, 30 * 60_000 + 50 - elapsed));
        while (settledTasks < tasks.mock.results.length) {
          const pending = tasks.mock.results.slice(settledTasks);
          settledTasks += pending.length;
          await withinTest(Promise.all(pending.map((result) => result.value)), signal);
        }
      }
    };
    try {
      const first = await prepare();
      const initialTasks = tasks.mock.calls.length;
      expect(await prepare()).toEqual(first);
      expect(tasks).toHaveBeenCalledTimes(initialTasks);
      expect(names(await prepare(undefined, ["cached-skill"]))).toEqual(["cached-skill"]);
      for (const execution of executions) {
        const entries = await prepare(execution);
        expect(names(entries)).toEqual(["cached-skill", "execution-skill"]);
        expect(entries.map(({ skill }) => skill.description)).toEqual(["Agent skill", execution]);
      }
      const version = getSkillsSnapshotVersion(dir);
      await write(executions[0], ["cached-skill", "Changed loser"]);
      await scan();
      expect((await prepare(executions[0]))[0]?.skill.description).toBe("Agent skill");
      expect(getSkillsSnapshotVersion(dir)).toBe(version);
      await write(dir, ["fresh-skill", "Fresh skill"]);
      await scan();
      for (const execution of executions) {
        expect(names(await prepare(execution))).toEqual([
          "cached-skill",
          "fresh-skill",
          "execution-skill",
        ]);
      }
      expect(getSkillsSnapshotVersion(dir)).toBeGreaterThan(version);
    } finally {
      tasks.mockRestore();
    }
  });

  it("refreshes plugin metadata with cached discovery", async () => {
    const dir = await newDir();
    await plugin(dir, "workspace-skills", "drafting");
    const config = { plugins: { entries: { "workspace-skills": { enabled: true } } } };
    const executionWorkspaceDir = await newDir();
    const options = { config, executionWorkspaceDir };
    expect(names(load(dir, options))).toContain("drafting");
    const pluginMetadataSnapshot = metadata(dir, config, { plugins: [], diagnostics: [] });
    expect(names(load(dir, { ...options, pluginMetadataSnapshot }))).not.toContain("drafting");
  });

  it("loads hardlinked skills only from trusted bundled plugins", async () => {
    const dir = await newDir();
    const packageCacheDir = path.join(dir, ".package-cache");
    await fs.mkdir(packageCacheDir, { recursive: true });

    for (const [id, name] of [
      ["browser", "bundled-hardlinked-skill"],
      ["workspace-skills", "workspace-hardlinked-skill"],
    ]) {
      const skillFile = await plugin(dir, id, name);
      await fs.link(skillFile, path.join(packageCacheDir, `${name}.md`));
      expect((await fs.stat(skillFile)).nlink).toBeGreaterThan(1);
    }

    const warn = captureWarningLogger();
    const entries = load(dir, {
      config: {
        plugins: {
          entries: { browser: { enabled: true }, "workspace-skills": { enabled: true } },
        },
      },
    });

    expect(names(entries)).toContain("bundled-hardlinked-skill");
    expect(names(entries)).not.toContain("workspace-hardlinked-skill");
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual(
      expect.arrayContaining([expect.stringContaining("workspace-hardlinked-skill")]),
    );
  });

  it.each([
    [
      false,
      "unterminated",
      "description: Missing closing delimiter\n",
      "invalid frontmatter: UNTERMINATED_FRONTMATTER: missing closing --- delimiter",
    ],
    [true, "descriptionless", "---\n", "description is required"],
  ] as const)(
    "warns for invalid skills (configured root: %s) while loading siblings",
    async (configured, name, suffix, message) => {
      const dir = await newDir();
      const root = path.join(dir, configured ? "configured-skills" : "skills");
      const invalidFile = await rawSkill(
        path.join(root, configured ? "group" : "", name),
        `---\nname: ${name}\n${suffix}`,
      );
      const unreadableFile = path.join(root, "group", "unreadable", "SKILL.md");
      const checkUnreadable = configured && process.platform !== "win32";
      if (checkUnreadable) {
        await fs.mkdir(path.dirname(unreadableFile), { recursive: true });
        await fs.symlink("SKILL.md", unreadableFile);
      }
      await named(configured ? path.join(root, "skills") : root, "valid", "Valid sibling");
      const warn = captureWarningLogger();

      const entries = load(dir, {
        config: { skills: { load: { extraDirs: configured ? [root] : [] } } },
      });
      const warningText = warn.mock.calls.flat().map(String).join("\n");

      expect(names(entries)).toContain("valid");
      expect(names(entries)).not.toContain(name);
      expect(warningText).toContain(invalidFile);
      expect(warningText).toContain(message);
      if (checkUnreadable) {
        expect(warningText).toContain(unreadableFile);
      }
    },
  );
});
