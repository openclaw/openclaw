import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { writeSkill, writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import type { OpenClawSkillMetadata, SkillEligibilityContext } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
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
  writeSkill({ dir: path.join(dir, name), name, description });
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

  async function fixture(
    skills: Array<{ name: string; metadata: OpenClawSkillMetadata }>,
    selection: {
      agentId?: string;
      skillFilter?: string[];
      skillOverrides?: Record<string, boolean>;
    } = {},
  ) {
    const workspaceDir = await createTempWorkspaceDir();
    const binDir = path.join(workspaceDir, "bin");
    const bundledSkillsDir = path.join(workspaceDir, ".bundled");
    await fs.mkdir(binDir);
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("PATHEXT", "");
    vi.stubEnv("OPENCLAW_TEST_PROBE_KEY", "");
    for (const skill of skills) {
      await writeSkill({
        dir: path.join(
          skill.name === "bundled" ? bundledSkillsDir : path.join(workspaceDir, "skills"),
          skill.name,
        ),
        name: skill.name,
        description: skill.name,
        metadata: JSON.stringify({ openclaw: skill.metadata }),
      });
    }
    const config: OpenClawConfig = { plugins: { enabled: false }, browser: { enabled: false } };
    const eligibility: SkillEligibilityContext = {};
    const options = {
      ...selection,
      config,
      eligibility,
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      pluginMetadataSnapshot: createWorkspacePluginMetadataSnapshot({
        workspaceDir,
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
    };
    const resolve = async (assertCurrent?: () => void) => {
      const entries = (
        await resolveWorkspaceSkillPromptEntries(workspaceDir, { ...options, assertCurrent })
      ).eligible;
      return entries.map((entry) => entry.skill.name);
    };
    return { binDir, config, eligibility, resolve };
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
      {
        name: "env",
        metadata: { requires: { bins: ["env-tool"], env: ["OPENCLAW_TEST_PROBE_KEY"] } },
      },
      {
        name: "config",
        metadata: { requires: { anyBins: ["config-tool"], config: ["browser.enabled"] } },
      },
      { name: "disabled", metadata: { always: true, requires: { bins: ["disabled-tool"] } } },
      { name: "secret", metadata: { always: true, requires: { bins: ["secret-tool"] } } },
      {
        name: "os",
        metadata: { always: true, os: ["unsupported-fixture-os"], requires: { bins: ["os-tool"] } },
      },
      { name: "bundled", metadata: { requires: { bins: ["bundled-tool"] } } },
      { name: "always", metadata: { always: true, requires: { bins: ["always-tool"] } } },
      { name: "ordinary", metadata: { requires: { anyBins: ["missing-tool", "installed-tool"] } } },
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
      { name: "ordinary", metadata: { requires: { bins: ["installed-tool"] } } },
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

let fakeHome = "";
let envSnapshot: SkillsHomeEnvSnapshot;
let tempRoot = "";
let workspaceCaseIndex = 0;

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
    plugins.push({
      id: manifest.id ?? id,
      origin: id === "browser" ? "bundled" : "workspace",
      enabledByDefault: manifest.enabledByDefault,
      channels: [],
      providers: [],
      cliBackends: [],
      legacyPluginIds: [],
      kind: [],
      skills: manifest.skills ?? ["./skills"],
      hooks: [],
      rootDir,
      source: rootDir,
      manifestPath,
      configSchema: manifest.configSchema,
    });
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

async function createTempWorkspaceDir() {
  const workspaceDir = path.join(tempRoot, `workspace-${++workspaceCaseIndex}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

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

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-workspace-"));
  fakeHome = path.join(tempRoot, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  envSnapshot = setMockSkillsHomeEnv(fakeHome);
});

afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.useRealTimers();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

afterAll(async () => {
  await restoreMockSkillsHomeEnv(envSnapshot, async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function setupWorkspaceSkillPlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "workspace-skills");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "workspace-skills",
    skillId: "drafting",
    skillDescription: "test",
  });

  return { workspaceDir, managedDir };
}

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
    const mergedControlUi = visible.find((entry) => entry.skill.name === "control-ui");
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
    const [bundledControlUi] = bundledEntries;

    expect(mergedControlUi?.skill.source).toBe("openclaw-workspace");
    expect(names(bundledEntries)).toEqual(["control-ui"]);
    expect(bundledControlUi?.skill.source).toBe("openclaw-bundled");
    expect(bundledControlUi?.skill.filePath).toBe(
      await fs.realpath(path.join(bundledSkillsDir, "control-ui", "SKILL.md")),
    );
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
    for (const [agentId, name] of [
      ["alpha", "alpha-only"],
      ["beta", "beta-only"],
    ] as const) {
      await writeNamedSkill(resolveWorkshopSkillsDir(config, agentId), name, `${agentId} skill`);
    }
    const alpha = loadWorkspaceSkills(workspaceDir, { config, agentId: "alpha" });
    const beta = loadWorkspaceSkills(workspaceDir, { config, agentId: "beta" });
    expect(names(alpha)).toContain("alpha-only");
    expect(names(alpha)).not.toContain("beta-only");
    expect(names(beta)).toContain("beta-only");
    expect(names(beta)).not.toContain("alpha-only");
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
    const { workspaceDir, managedDir } = await setupWorkspaceSkillPlugin();
    const config = { plugins: { entries: { "workspace-skills": { enabled: true } } } };
    const executionWorkspaceDir = await createTempWorkspaceDir();
    const options = { config, managedSkillsDir: managedDir, executionWorkspaceDir };
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

  it("warns for malformed files and keeps loading sibling workspace skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const brokenFile = await writeRawSkill(
      path.join(workspaceDir, "skills", "broken"),
      "---\nname: [broken\ndescription: Broken skill\n---\n",
    );
    const unterminatedFile = await writeRawSkill(
      path.join(workspaceDir, "skills", "unterminated"),
      "---\nname: unterminated\ndescription: Missing closing delimiter\n",
    );
    await writeNamedSkill(path.join(workspaceDir, "skills"), "valid", "Valid sibling");
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir);
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(names(entries)).toContain("valid");
    expect(names(entries)).not.toContain("broken");
    expect(warningText).toContain(brokenFile);
    expect(warningText).toContain("invalid frontmatter: BAD_INDENT");
    expect(names(entries)).not.toContain("unterminated");
    expect(warningText).toContain(unterminatedFile);
    expect(warningText).toContain(
      "invalid frontmatter: UNTERMINATED_FRONTMATTER: missing closing --- delimiter",
    );
  });

  it("warns for invalid configured-root skills while loading nested siblings", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const configuredRoot = path.join(workspaceDir, "configured-skills");
    const invalidFile = await writeRawSkill(
      path.join(configuredRoot, "group", "descriptionless"),
      "---\nname: descriptionless\n---\n",
    );
    const unreadableFile = path.join(configuredRoot, "group", "unreadable", "SKILL.md");
    if (process.platform !== "win32") {
      await fs.mkdir(path.dirname(unreadableFile), { recursive: true });
      await fs.symlink("SKILL.md", unreadableFile);
    }
    await writeNamedSkill(path.join(configuredRoot, "skills"), "valid", "Valid nested sibling");
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      config: { skills: { load: { extraDirs: [configuredRoot] } } },
    });
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(names(entries)).toContain("valid");
    expect(names(entries)).not.toContain("descriptionless");
    expect(warningText).toContain(invalidFile);
    expect(warningText).toContain("description is required");
    if (process.platform !== "win32") {
      expect(warningText).toContain(unreadableFile);
    }
  });
});
