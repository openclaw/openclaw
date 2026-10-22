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
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
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
const writeNamedSkill = (dir: string, name: string, description: string) =>
  writeSkillFixture(path.join(dir, name), name, description);
async function writeRawSkill(dir: string, content: string) {
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
    const workspaceDir = await createTempWorkspaceDir();
    const binDir = path.join(workspaceDir, "bin");
    const bundledSkillsDir = path.join(workspaceDir, ".bundled");
    await fs.mkdir(binDir);
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("PATHEXT", "");
    vi.stubEnv("OPENCLAW_TEST_PROBE_KEY", "");
    for (const [name, metadata] of skills) {
      await writeSkillFixture(
        path.join(name === "bundled" ? bundledSkillsDir : path.join(workspaceDir, "skills"), name),
        name,
        name,
        { metadata: JSON.stringify({ openclaw: metadata }) },
      );
    }
    const config: OpenClawConfig = { plugins: { enabled: false }, browser: { enabled: false } };
    const options = {
      config,
      eligibility: {},
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      pluginMetadataSnapshot: createWorkspacePluginMetadataSnapshot({
        workspaceDir,
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
    };
    const resolve = async (assertCurrent?: () => void) =>
      names(
        (await resolveWorkspaceSkillPromptEntries(workspaceDir, { ...options, assertCurrent }))
          .eligible,
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

  it("skips binary IO for cheap exclusions and always skills, while detecting newly installed tools", async () => {
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

  it("keeps concurrent binary preparations independent when one caller is canceled", async () => {
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

function createWorkspacePluginRegistry(workspaceDir: string): PluginManifestRegistry {
  const extensionsRoot = path.join(workspaceDir, ".openclaw", "extensions");
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

function createWorkspacePluginMetadataSnapshot(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const snapshot = createPluginMetadataSnapshotFixture(params.manifestRegistry);
  return {
    ...snapshot,
    policyHash,
    workspaceDir: params.workspaceDir,
    index: { ...snapshot.index, policyHash },
    registryIndex: { ...snapshot.registryIndex, policyHash },
    normalizePluginId: (pluginId) => pluginId,
  };
}

const createTempWorkspaceDir = () => fixture.createDir();

function loadTestWorkspaceSkills(
  workspaceDir: string,
  opts?: Parameters<typeof loadWorkspaceSkills>[1],
) {
  const pluginMetadataSnapshot = createWorkspacePluginMetadataSnapshot({
    workspaceDir,
    manifestRegistry: createWorkspacePluginRegistry(workspaceDir),
    ...(opts?.config === undefined ? {} : { config: opts.config }),
  });
  return loadWorkspaceSkills(workspaceDir, {
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    ...opts,
    pluginMetadataSnapshot: opts?.pluginMetadataSnapshot ?? pluginMetadataSnapshot,
  });
}

afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.useRealTimers();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

describe("loadWorkspaceSkills", () => {
  it("keeps an eligible bundled skill addressable across a workspace collision", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const bundledSkillsDir = path.join(workspaceDir, ".bundled");
    const executionWorkspaceDir = await createTempWorkspaceDir();
    await writeNamedSkill(bundledSkillsDir, "control-ui", "Bundled Control UI");
    await writeNamedSkill(path.join(workspaceDir, "skills"), "control-ui", "Workspace replacement");
    await writeWorkspaceSkills(executionWorkspaceDir, [
      { name: "execution-only", description: "Unrelated execution skill" },
    ]);

    const visible = loadVisibleSkills(workspaceDir, {
      config: {},
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const bundledEntries = await prepareWorkspaceSkills(workspaceDir, {
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
      config: {},
      bundledSkillsDir,
    });
    expect(visible.find((entry) => entry.skill.name === "control-ui")?.skill.source).toBe(
      "openclaw-workspace",
    );
    expect(names(bundledEntries)).toEqual(["control-ui"]);
    expect(bundledEntries[0]?.skill).toMatchObject({
      source: "openclaw-bundled",
      filePath: await fs.realpath(path.join(bundledSkillsDir, "control-ui", "SKILL.md")),
    });
  });

  it("loads each agent's Workshop directory without leaking the other agent's skill", async () => {
    const root = await createTempWorkspaceDir();
    const workspaceDir = path.join(root, "workspace");
    const config = {
      agents: {
        entries: {
          alpha: { agentDir: path.join(root, "alpha"), workspace: workspaceDir },
          beta: { agentDir: path.join(root, "beta"), workspace: workspaceDir },
        },
      },
    } satisfies OpenClawConfig;
    for (const agentId of ["alpha", "beta"]) {
      await writeNamedSkill(
        resolveWorkshopSkillsDir(config, agentId),
        `${agentId}-only`,
        `${agentId} skill`,
      );
    }
    for (const agentId of ["alpha", "beta"]) {
      const skills = names(loadWorkspaceSkills(workspaceDir, { config, agentId }));
      expect(skills).toContain(`${agentId}-only`);
      expect(skills).not.toContain(`${agentId === "alpha" ? "beta" : "alpha"}-only`);
    }
  });
  it("reuses discovery across execution scopes until automatic refresh", async ({ signal }) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(0);
    const workspaceDir = await createTempWorkspaceDir();
    const executionDirs = [await createTempWorkspaceDir(), await createTempWorkspaceDir()] as const;
    await writeWorkspaceSkills(workspaceDir, [
      { name: "cached-skill", description: "Agent skill" },
    ]);
    for (const executionDir of executionDirs) {
      await writeWorkspaceSkills(executionDir, [
        { name: "cached-skill", description: "Losing execution copy" },
        { name: "execution-skill", description: executionDir },
      ]);
    }
    const options = {
      config: { plugins: { enabled: false } },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: "",
      pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    };
    const scoped = (executionWorkspaceDir: string) => ({ ...options, executionWorkspaceDir });
    const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
    const completePassiveScan = async () => {
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
      const first = await prepareWorkspaceSkills(workspaceDir, options);
      const initialTasks = tasks.mock.calls.length;
      expect(await prepareWorkspaceSkills(workspaceDir, options)).toEqual(first);
      expect(tasks).toHaveBeenCalledTimes(initialTasks);
      const filtered = await prepareWorkspaceSkills(workspaceDir, {
        ...options,
        skillFilter: ["cached-skill"],
      });
      expect(names(filtered)).toEqual(["cached-skill"]);
      for (const executionDir of executionDirs) {
        const entries = await prepareWorkspaceSkills(workspaceDir, scoped(executionDir));
        expect(names(entries)).toEqual(["cached-skill", "execution-skill"]);
        expect(entries.map(({ skill }) => skill.description)).toEqual([
          "Agent skill",
          executionDir,
        ]);
      }
      const changedExecutionDir = executionDirs[0];
      const version = getSkillsSnapshotVersion(workspaceDir);
      await writeWorkspaceSkills(changedExecutionDir, [
        { name: "cached-skill", description: "Changed loser" },
      ]);
      await completePassiveScan();
      expect(
        (await prepareWorkspaceSkills(workspaceDir, scoped(changedExecutionDir)))[0]?.skill
          .description,
      ).toBe("Agent skill");
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      await writeWorkspaceSkills(workspaceDir, [
        { name: "fresh-skill", description: "Fresh skill" },
      ]);
      await completePassiveScan();
      for (const executionDir of executionDirs) {
        expect(names(await prepareWorkspaceSkills(workspaceDir, scoped(executionDir)))).toEqual([
          "cached-skill",
          "fresh-skill",
          "execution-skill",
        ]);
      }
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
    } finally {
      tasks.mockRestore();
    }
  });

  it("uses incoming plugin metadata when reusing source discovery", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writePluginWithSkill({
      pluginRoot: path.join(workspaceDir, ".openclaw", "extensions", "workspace-skills"),
      pluginId: "workspace-skills",
      skillId: "drafting",
      skillDescription: "test",
    });
    const config = { plugins: { entries: { "workspace-skills": { enabled: true } } } };
    const executionWorkspaceDir = await createTempWorkspaceDir();
    const options = { config, executionWorkspaceDir };
    expect(names(loadTestWorkspaceSkills(workspaceDir, options))).toContain("drafting");
    const pluginMetadataSnapshot = createWorkspacePluginMetadataSnapshot({
      workspaceDir,
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    expect(
      names(loadTestWorkspaceSkills(workspaceDir, { ...options, pluginMetadataSnapshot })),
    ).not.toContain("drafting");
  });

  it("loads hardlinked skills only from trusted bundled plugins", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const packageCacheDir = path.join(workspaceDir, ".package-cache");
    await fs.mkdir(packageCacheDir, { recursive: true });

    for (const plugin of [
      { id: "browser", skill: "bundled-hardlinked-skill" },
      { id: "workspace-skills", skill: "workspace-hardlinked-skill" },
    ]) {
      const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", plugin.id);
      await writePluginWithSkill({
        pluginRoot,
        pluginId: plugin.id,
        skillId: plugin.skill,
        skillDescription: `${plugin.id} hardlink fixture`,
      });
      const skillFile = path.join(pluginRoot, "skills", plugin.skill, "SKILL.md");
      await fs.link(skillFile, path.join(packageCacheDir, `${plugin.skill}.md`));
      expect((await fs.stat(skillFile)).nlink).toBeGreaterThan(1);
    }

    const warn = captureWarningLogger();
    const entries = loadTestWorkspaceSkills(workspaceDir, {
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
      const workspaceDir = await createTempWorkspaceDir();
      const root = path.join(workspaceDir, configured ? "configured-skills" : "skills");
      const invalidFile = await writeRawSkill(
        path.join(root, configured ? "group" : "", name),
        `---\nname: ${name}\n${suffix}`,
      );
      const unreadableFile = path.join(root, "group", "unreadable", "SKILL.md");
      const checkUnreadable = configured && process.platform !== "win32";
      if (checkUnreadable) {
        await fs.mkdir(path.dirname(unreadableFile), { recursive: true });
        await fs.symlink("SKILL.md", unreadableFile);
      }
      await writeNamedSkill(
        configured ? path.join(root, "skills") : root,
        "valid",
        "Valid sibling",
      );
      const warn = captureWarningLogger();

      const entries = loadTestWorkspaceSkills(workspaceDir, {
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
