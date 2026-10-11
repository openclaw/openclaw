import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import type {
  PluginManifestRecord,
  PluginManifestRegistry,
} from "../../plugins/manifest-registry.js";
// Workspace skill loader tests cover source merging, metadata, filtering, and precedence.
import { buildPluginMetadataProviderFacts } from "../../plugins/plugin-metadata-provider-facts.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { buildDeclaredProviderOwnerIndex } from "../../plugins/provider-owner-index.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  getSkillsSourceVersion,
} from "../runtime/refresh-state.js";
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

vi.mock("../../plugins/manifest-registry.js", async () => {
  const fsLocal = await import("node:fs");
  const pathLocal = await import("node:path");
  return {
    loadPluginManifestRegistryCore: (params: { workspaceDir?: string }) => {
      const extensionsRoot = pathLocal.join(params.workspaceDir ?? "", ".openclaw", "extensions");
      const plugins = [];
      for (const id of ["workspace-skills", "browser"]) {
        const rootDir = pathLocal.join(extensionsRoot, id);
        const manifestPath = pathLocal.join(rootDir, "openclaw.plugin.json");
        if (!fsLocal.existsSync(manifestPath)) {
          continue;
        }
        const manifest = JSON.parse(fsLocal.readFileSync(manifestPath, "utf8")) as {
          enabledByDefault?: boolean;
          skills?: string[];
        };
        plugins.push({
          id,
          origin: id === "browser" ? "bundled" : "workspace",
          enabledByDefault: manifest.enabledByDefault,
          providers: [],
          legacyPluginIds: [],
          kind: [],
          skills: manifest.skills ?? ["./skills"],
          rootDir,
        });
      }
      return { plugins, diagnostics: [] };
    },
  };
});

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
    expect(await Promise.all([resolve(), resolve()])).toEqual([["always"], ["always"]]);
    expect(access.mock.calls.map(([file]) => path.basename(String(file))).toSorted()).toEqual([
      "installed-tool",
      "missing-tool",
    ]);
    await fs.writeFile(path.join(binDir, "installed-tool"), "fixture", { mode: 0o755 });
    access.mockClear();
    expect(await resolve()).toEqual(["always", "ordinary"]);
    expect(access.mock.calls.map(([file]) => path.basename(String(file))).toSorted()).toEqual([
      "installed-tool",
      "missing-tool",
    ]);
    access.mockClear();
    expect(await resolve()).toEqual(["always", "ordinary"]);
    expect(access.mock.calls.map(([file]) => path.basename(String(file)))).toEqual([
      "missing-tool",
    ]);
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

  it("prepares newly eligible binaries after awaited env, config, secret, selection and remote changes", async () => {
    const skillOverrides = { selected: false };
    const { binDir, config, eligibility, resolve } = await fixture(
      [
        { name: "gate", metadata: { requires: { bins: ["gate-tool"] } } },
        {
          name: "env",
          metadata: { requires: { bins: ["env-tool"], env: ["OPENCLAW_TEST_PROBE_KEY"] } },
        },
        {
          name: "config",
          metadata: {
            requires: { anyBins: ["missing-tool", "config-tool"], config: ["browser.enabled"] },
          },
        },
        { name: "secret", metadata: { requires: { bins: ["secret-tool"] } } },
        {
          name: "remote",
          metadata: { os: ["remote-fixture-os"], requires: { bins: ["remote-tool"] } },
        },
        { name: "revoked", metadata: { requires: { bins: ["revoked-tool"] } } },
        { name: "selected", metadata: { requires: { bins: ["selected-tool"] } } },
      ],
      { skillOverrides },
    );
    for (const name of ["gate", "env", "config", "secret", "revoked", "selected"]) {
      await fs.writeFile(path.join(binDir, `${name}-tool`), "fixture", { mode: 0o755 });
    }
    degrade("secret");
    const entered = createDeferred();
    const release = createDeferred();
    const actualAccess = fs.access;
    let held = false;
    const access = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (!held && args[0] === path.join(binDir, "gate-tool")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return actualAccess(...args);
    });
    const syncAccess = vi.spyOn(fsSync, "accessSync");
    const pending = resolve();
    try {
      await entered.promise;
      vi.stubEnv("OPENCLAW_TEST_PROBE_KEY", "available");
      config.browser = { enabled: true };
      config.skills = { entries: { revoked: { enabled: false } } };
      skillOverrides.selected = true;
      setActiveDegradedSecretOwners([]);
      eligibility.remote = {
        platforms: ["remote-fixture-os"],
        hasBin: (bin) => bin === "remote-tool",
        hasAnyBin: () => false,
      };
    } finally {
      release.resolve();
    }
    expect(await pending).toEqual(["config", "env", "gate", "remote", "secret", "selected"]);
    expect(access.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(
      expect.arrayContaining([
        "env-tool",
        "config-tool",
        "missing-tool",
        "remote-tool",
        "secret-tool",
        "selected-tool",
      ]),
    );
    expect(syncAccess.mock.calls.filter(([file]) => path.dirname(String(file)) === binDir)).toEqual(
      [],
    );
    eligibility.remote.hasBin = () => false;
    expect(await resolve()).toEqual(["config", "env", "gate", "secret", "selected"]);
  });

  it("discards binary facts when PATH changes during an awaited probe", async () => {
    const { binDir, resolve } = await fixture([
      { name: "tool", metadata: { requires: { bins: ["selected-tool"] } } },
    ]);
    const replacement = path.join(binDir, "replacement");
    await fs.mkdir(replacement);
    await fs.writeFile(path.join(binDir, "selected-tool"), "fixture", { mode: 0o755 });
    const actualAccess = fs.access;
    const access = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (args[0] === path.join(binDir, "selected-tool")) {
        vi.stubEnv("PATH", replacement);
      }
      return actualAccess(...args);
    });
    expect(await resolve()).toEqual([]);
    expect(access.mock.calls.map(([file]) => String(file))).toEqual([
      path.join(binDir, "selected-tool"),
      path.join(replacement, "selected-tool"),
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
  const ownerMaps = {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    providerAuthContributions: buildPluginMetadataProviderFacts(params.manifestRegistry.plugins)
      .providerAuthContributions,
    modelIdNormalizationPolicies: new Map(),
  };
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 1,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash,
    workspaceDir: params.workspaceDir,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: params.manifestRegistry,
    plugins: params.manifestRegistry.plugins,
    diagnostics: params.manifestRegistry.diagnostics,
    byPluginId: new Map(params.manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(params.manifestRegistry.plugins),
    owners: ownerMaps,
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: params.manifestRegistry.plugins.length,
    },
  };
}

async function expectMissingPath(pathToCheck: string) {
  let thrown: unknown;
  try {
    await fs.lstat(pathToCheck);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
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
    await writeSkill({
      dir: path.join(bundledSkillsDir, "control-ui"),
      name: "control-ui",
      description: "Bundled Control UI",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "control-ui"),
      name: "control-ui",
      description: "Workspace replacement",
    });

    const visible = loadVisibleSkills(workspaceDir, {
      config: {},
      bundledSkillsDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const mergedControlUi = visible.find((entry) => entry.skill.name === "control-ui");
    const [bundledControlUi] = await prepareWorkspaceSkills(workspaceDir, {
      bundledSkillName: "control-ui",
      eligibility: {},
      config: {},
      bundledSkillsDir,
    });

    expect(mergedControlUi?.skill.source).toBe("openclaw-workspace");
    expect(bundledControlUi?.skill.source).toBe("openclaw-bundled");
    expect(bundledControlUi?.skill.filePath).toBe(
      await fs.realpath(path.join(bundledSkillsDir, "control-ui", "SKILL.md")),
    );
  });

  it("loads each agent's Workshop directory without leaking the other agent's skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workshop-isolation-"));
    const alphaDir = path.join(root, "alpha");
    const betaDir = path.join(root, "beta");
    const workspaceDir = path.join(root, "workspace");
    const config = {
      agents: {
        entries: {
          alpha: { agentDir: alphaDir, workspace: workspaceDir },
          beta: { agentDir: betaDir, workspace: workspaceDir },
        },
      },
    } satisfies OpenClawConfig;
    try {
      const agentSkills: ReadonlyArray<readonly [string, string]> = [
        ["alpha", "alpha-only"],
        ["beta", "beta-only"],
      ];
      for (const [agentId, name] of agentSkills) {
        await writeSkill({
          dir: path.join(resolveWorkshopSkillsDir(config, agentId), name),
          name,
          description: `${agentId} skill`,
        });
      }
      const alpha = loadWorkspaceSkills(workspaceDir, {
        config,
        agentId: "alpha",
      });
      const beta = loadWorkspaceSkills(workspaceDir, {
        config,
        agentId: "beta",
      });
      expect(alpha.map((entry) => entry.skill.name)).toContain("alpha-only");
      expect(alpha.map((entry) => entry.skill.name)).not.toContain("beta-only");
      expect(beta.map((entry) => entry.skill.name)).toContain("beta-only");
      expect(beta.map((entry) => entry.skill.name)).not.toContain("alpha-only");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each([true])(
    "reconciles incoming plugin metadata with scoped invalidation=%s",
    async (scoped) => {
      const { workspaceDir, managedDir } = await setupWorkspaceSkillPlugin();
      const config = { plugins: { entries: { "workspace-skills": { enabled: true } } } };
      const executionWorkspaceDir = scoped ? await createTempWorkspaceDir() : undefined;
      const options = { config, managedSkillsDir: managedDir, executionWorkspaceDir };
      const sourceVersion = getSkillsSourceVersion(workspaceDir);
      expect(
        loadTestWorkspaceSkills(workspaceDir, options).map((entry) => entry.skill.name),
      ).toContain("drafting");
      const version = getSkillsSnapshotVersion(workspaceDir);
      const pluginMetadataSnapshot = createWorkspacePluginMetadataSnapshot({
        workspaceDir,
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      bumpSkillsSnapshotVersion({
        workspaceDir,
        reason: "watch-targets",
        sourceScopes: scoped ? [{ executionWorkspaceDir }] : undefined,
        refreshInputs: { sourceScope: { executionWorkspaceDir }, config, pluginMetadataSnapshot },
      });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
      if (scoped) {
        expect(getSkillsSourceVersion(workspaceDir)).toBe(sourceVersion);
      }
      expect(
        loadTestWorkspaceSkills(workspaceDir, { ...options, pluginMetadataSnapshot }).map(
          (entry) => entry.skill.name,
        ),
      ).not.toContain("drafting");
    },
  );

  it("loads the browser plugin automation skill when the bundled plugin is enabled", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "browser");

    await writePluginWithSkill({
      pluginRoot,
      pluginId: "browser",
      skillId: "browser-automation",
      skillDescription: "Browser automation",
    });
    await fs.writeFile(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "browser",
          enabledByDefault: true,
          skills: ["./skills"],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      ),
      "utf8",
    );

    const enabledEntries = loadTestWorkspaceSkills(workspaceDir, {
      config: {},
      managedSkillsDir: managedDir,
    });

    const browserEntry = enabledEntries.find((entry) => entry.skill.name === "browser-automation");
    const browserSkillDir = path.join(pluginRoot, "skills", "browser-automation");
    expect(browserEntry?.skill.baseDir).toBe(
      path.join(workspaceDir, ".plugin-skills", "browser-automation"),
    );
    expect(browserEntry?.skill.filePath).toBe(
      path.join(workspaceDir, ".plugin-skills", "browser-automation", "SKILL.md"),
    );
    await expect(
      fs.readlink(path.join(workspaceDir, ".plugin-skills", "browser-automation")),
    ).resolves.toBe(browserSkillDir);

    const blockedEntries = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        plugins: {
          entries: { browser: { enabled: false } },
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(blockedEntries.map((entry) => entry.skill.name)).not.toContain("browser-automation");
    await expectMissingPath(path.join(workspaceDir, ".plugin-skills", "browser-automation"));
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

    expect(entries.map((entry) => entry.skill.name)).toContain("bundled-hardlinked-skill");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("workspace-hardlinked-skill");
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual(
      expect.arrayContaining([expect.stringContaining("workspace-hardlinked-skill")]),
    );
  });

  it("warns for malformed files and keeps loading sibling workspace skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const brokenDir = path.join(workspaceDir, "skills", "broken");
    const brokenFile = path.join(brokenDir, "SKILL.md");
    const unterminatedDir = path.join(workspaceDir, "skills", "unterminated");
    const unterminatedFile = path.join(unterminatedDir, "SKILL.md");
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.mkdir(unterminatedDir, { recursive: true });
    await fs.writeFile(
      brokenFile,
      `---
name: [broken
description: Broken skill
---
`,
      "utf8",
    );
    await fs.writeFile(
      unterminatedFile,
      "---\nname: unterminated\ndescription: Missing closing delimiter\n",
      "utf8",
    );
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "valid"),
      name: "valid",
      description: "Valid sibling",
    });
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir);
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(entries.map((entry) => entry.skill.name)).toContain("valid");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("broken");
    expect(warningText).toContain(brokenFile);
    expect(warningText).toContain("invalid frontmatter: BAD_INDENT");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("unterminated");
    expect(warningText).toContain(unterminatedFile);
    expect(warningText).toContain(
      "invalid frontmatter: UNTERMINATED_FRONTMATTER: missing closing --- delimiter",
    );
  });

  it("warns for invalid configured-root skills while loading nested siblings", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const configuredRoot = path.join(workspaceDir, "configured-skills");
    const invalidFile = path.join(configuredRoot, "group", "descriptionless", "SKILL.md");
    const unreadableFile = path.join(configuredRoot, "group", "unreadable", "SKILL.md");
    await fs.mkdir(path.dirname(invalidFile), { recursive: true });
    await fs.writeFile(invalidFile, "---\nname: descriptionless\n---\n", "utf8");
    if (process.platform !== "win32") {
      await fs.mkdir(path.dirname(unreadableFile), { recursive: true });
      await fs.symlink("SKILL.md", unreadableFile);
    }
    await writeSkill({
      dir: path.join(configuredRoot, "skills", "valid"),
      name: "valid",
      description: "Valid nested sibling",
    });
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      config: { skills: { load: { extraDirs: [configuredRoot] } } },
    });
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(entries.map((entry) => entry.skill.name)).toContain("valid");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("descriptionless");
    expect(warningText).toContain(invalidFile);
    expect(warningText).toContain("description is required");
    if (process.platform !== "win32") {
      expect(warningText).toContain(unreadableFile);
    }
  });
});
