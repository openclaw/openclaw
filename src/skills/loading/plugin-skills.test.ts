// Plugin skill loading tests cover skill discovery from plugin-provided skill bundles.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing as acpRuntimeTesting,
  registerAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "../../plugins/install-root-context.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

const hoisted = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  const loadPluginMetadataSnapshot = vi.fn((_params?: unknown) => {
    const manifestRegistry = loadManifestRegistry();
    return {
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      normalizePluginId: (pluginId: string) =>
        manifestRegistry.plugins.find((plugin: { id: string; legacyPluginIds?: string[] }) =>
          plugin.legacyPluginIds?.includes(pluginId),
        )?.id ?? pluginId,
    };
  });
  const resolvePluginMetadataSnapshot = vi.fn((params: unknown) =>
    loadPluginMetadataSnapshot(params),
  );
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginMetadataSnapshot,
    resolvePluginMetadataSnapshot,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  };
});

vi.mock("../../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: hoisted.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: hoisted.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: hoisted.loadPluginRegistrySnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: hoisted.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: hoisted.resolvePluginMetadataSnapshot,
}));

let resolvePluginSkillRoots: typeof import("./plugin-skills.js").resolvePluginSkillRoots;

const tempDirs = createTrackedTempDirs();
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

function buildRegistry(params: { acpxRoot: string; helperRoot: string }): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "acpx",
        name: "ACPX Runtime",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: ["./skills"],
        hooks: [],
        origin: "workspace",
        rootDir: params.acpxRoot,
        source: params.acpxRoot,
        manifestPath: path.join(params.acpxRoot, "openclaw.plugin.json"),
      },
      {
        id: "helper",
        name: "Helper",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: ["./skills"],
        hooks: [],
        origin: "workspace",
        rootDir: params.helperRoot,
        source: params.helperRoot,
        manifestPath: path.join(params.helperRoot, "openclaw.plugin.json"),
      },
    ],
  };
}

function createSinglePluginRegistry(params: {
  pluginRoot: string;
  skills: string[];
  format?: "openclaw" | "bundle";
  bundleFormat?: "agent" | "codex" | "claude" | "cursor";
  legacyPluginIds?: string[];
}): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "helper",
        name: "Helper",
        format: params.format,
        bundleFormat: params.bundleFormat,
        channels: [],
        providers: [],
        cliBackends: [],
        legacyPluginIds: params.legacyPluginIds,
        skills: params.skills,
        hooks: [],
        origin: "workspace",
        rootDir: params.pluginRoot,
        source: params.pluginRoot,
        manifestPath: path.join(params.pluginRoot, "openclaw.plugin.json"),
      },
    ],
  };
}

async function setupAcpxAndHelperRegistry() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const acpxRoot = await tempDirs.make("openclaw-acpx-plugin-");
  const helperRoot = await tempDirs.make("openclaw-helper-plugin-");
  await fs.mkdir(path.join(acpxRoot, "skills"), { recursive: true });
  await fs.mkdir(path.join(helperRoot, "skills"), { recursive: true });
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
    buildRegistry({ acpxRoot, helperRoot }),
  );
  return { workspaceDir, acpxRoot, helperRoot };
}

function useStableMetadataSnapshot(manifestRegistry: PluginManifestRegistry): void {
  const snapshot = {
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    normalizePluginId: (pluginId: string) =>
      manifestRegistry.plugins.find((plugin) => plugin.legacyPluginIds?.includes(pluginId))?.id ??
      pluginId,
  };
  hoisted.loadPluginMetadataSnapshot
    .mockReturnValueOnce(snapshot)
    .mockReturnValueOnce(snapshot)
    .mockReturnValueOnce(snapshot);
}

async function setupPluginOutsideSkills() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const pluginRoot = await tempDirs.make("openclaw-plugin-");
  const outsideDir = await tempDirs.make("openclaw-outside-");
  const outsideSkills = path.join(outsideDir, "skills");
  return { workspaceDir, pluginRoot, outsideSkills };
}

function registerHealthyAcpBackend() {
  registerAcpRuntimeBackend({
    id: "acpx",
    runtime: {
      async ensureSession(input) {
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: input.sessionKey,
        };
      },
      async *runTurn() {
        yield { type: "done" as const };
      },
      async cancel() {},
      async close() {},
    },
  });
}

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReset();
  hoisted.loadPluginMetadataSnapshot.mockClear();
  hoisted.resolvePluginMetadataSnapshot.mockClear();
  hoisted.loadPluginRegistrySnapshot.mockReset();
  acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
  await tempDirs.cleanup();
});

describe("resolvePluginSkillRoots", () => {
  beforeAll(async () => {
    ({ resolvePluginSkillRoots } = await import("./plugin-skills.js"));
  });

  beforeEach(() => {
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReset();
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      diagnostics: [],
      plugins: [],
    });
    hoisted.loadPluginMetadataSnapshot.mockClear();
    hoisted.resolvePluginMetadataSnapshot.mockClear();
    hoisted.loadPluginRegistrySnapshot.mockReset();
    hoisted.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
  });

  it("keeps package skill targets stable across config changes while publishing live selection", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await tempDirs.make("openclaw-plugin-");
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const skillsRoot = path.join(pluginRoot, "skills");
    const original = path.join(skillsRoot, "original");
    const added = path.join(skillsRoot, "added");
    await fs.mkdir(original, { recursive: true });
    await fs.writeFile(path.join(original, "SKILL.md"), "# Original\n");
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({ pluginRoot, skills: ["./skills"] }),
    );
    const config: OpenClawConfig = { plugins: { entries: { helper: { enabled: true } } } };
    const resolve = (nextConfig = config) =>
      resolvePluginSkillRoots({ workspaceDir, config: nextConfig, pluginSkillsDir });
    resolve();
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "original"))).toBe(original);

    await fs.mkdir(added);
    await fs.writeFile(path.join(added, "SKILL.md"), "# Added\n");
    resolve({ ...config });
    await expectPathMissing(path.join(pluginSkillsDir, "added"));

    withPluginCache(createPluginCache(), () => resolve({ ...config }));
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "added"))).toBe(added);
    resolve({ ...config });
    await expectPathMissing(path.join(pluginSkillsDir, "added"));

    resolve({ plugins: { entries: { helper: { enabled: false } } } });
    await expectPathMissing(path.join(pluginSkillsDir, "original"));
  });

  it.each([{ channelEnabled: false, expectsSkills: false }])(
    "honors channels.<id>.enabled=$channelEnabled through the manifest channel id when it differs from the plugin id",
    async ({ channelEnabled, expectsSkills }) => {
      const workspaceDir = await tempDirs.make("openclaw-");
      const pluginRoot = await tempDirs.make("openclaw-demo-plugin-");
      await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
      // QQ Bot style: plugin `openclaw-demo` owns `channels.demo`; the plugin id alone
      // cannot resolve that channel key.
      hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "openclaw-demo",
            name: "Demo",
            channels: ["demo"],
            providers: [],
            cliBackends: [],
            skills: ["./skills"],
            hooks: [],
            origin: "bundled",
            rootDir: pluginRoot,
            source: pluginRoot,
            manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
          },
        ],
      });

      const roots = resolvePluginSkillRoots({
        workspaceDir,
        config: {
          channels: { demo: { enabled: channelEnabled } },
          plugins: { entries: { "openclaw-demo": { enabled: true } } },
        } as OpenClawConfig,
      });

      expect(roots.map((root) => root.dir)).toEqual(
        expectsSkills ? [path.resolve(pluginRoot, "skills")] : [],
      );
    },
  );

  it("skips acpx plugin skills when ACP is disabled", async () => {
    const { workspaceDir, helperRoot } = await setupAcpxAndHelperRegistry();
    registerHealthyAcpBackend();
    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        acp: { enabled: false },
        plugins: { entries: { acpx: { enabled: true }, helper: { enabled: true } } },
      },
    });
    expect(roots.map((root) => root.dir)).toEqual([path.resolve(helperRoot, "skills")]);
  });

  it.each([
    {
      name: "unavailable to available",
      initiallyAvailable: false,
      firstIncludesAcpx: false,
      secondIncludesAcpx: true,
    },
    {
      name: "available to unavailable",
      initiallyAvailable: true,
      firstIncludesAcpx: true,
      secondIncludesAcpx: false,
    },
  ])(
    "invalidates the memo when ACP changes from $name with stable inputs",
    async ({ initiallyAvailable, firstIncludesAcpx, secondIncludesAcpx }) => {
      const { workspaceDir, acpxRoot, helperRoot } = await setupAcpxAndHelperRegistry();
      const manifestRegistry = buildRegistry({ acpxRoot, helperRoot });
      useStableMetadataSnapshot(manifestRegistry);
      const config = {
        acp: { enabled: true },
        plugins: {
          entries: {
            acpx: { enabled: true },
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig;
      if (initiallyAvailable) {
        registerHealthyAcpBackend();
      }

      const first = resolvePluginSkillRoots({ workspaceDir, config });

      if (initiallyAvailable) {
        acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
      } else {
        registerHealthyAcpBackend();
      }
      const second = resolvePluginSkillRoots({ workspaceDir, config });

      const dirsForState = (includeAcpx: boolean) => [
        ...(includeAcpx ? [path.resolve(acpxRoot, "skills")] : []),
        path.resolve(helperRoot, "skills"),
      ];
      expect(first.map((root) => root.dir)).toEqual(dirsForState(firstIncludesAcpx));
      expect(second.map((root) => root.dir)).toEqual(dirsForState(secondIncludesAcpx));
      expect(resolvePluginSkillRoots({ workspaceDir, config })).toEqual(second);
    },
  );

  it("publishes generated links in each active private state scope through the workspace loader", async () => {
    const workspaceDir = await tempDirs.make("openclaw-private-skills-");
    const pluginRoot = await tempDirs.make("openclaw-plugin-");
    const skillDir = path.join(pluginRoot, "skills", "helper");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: helper\ndescription: Helper\n---\n",
    );
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({ pluginRoot, skills: ["./skills"] }),
    );
    const roots = resolvePluginInstallRoots();
    for (const name of ["first", "second"]) {
      const stateDir = path.join(workspaceDir, name);
      const config = { plugins: { entries: { helper: { enabled: true } } } };
      withPluginInstallRoots({ ...roots, stateDir }, () => {
        loadWorkspaceSkills(workspaceDir, { config });
      });
      expect(await fs.readlink(path.join(stateDir, "plugin-skills", "helper"))).toBe(skillDir);
    }
  });

  it("rejects plugin skill paths that escape the plugin root", async () => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await fs.mkdir(outsideSkills, { recursive: true });
    const escapePath = path.relative(pluginRoot, outsideSkills);

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills", escapePath],
      }),
    );

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(roots).toEqual([{ dir: path.resolve(pluginRoot, "skills"), rejectHardlinks: true }]);
  });

  it("rejects plugin skill symlinks that resolve outside plugin root", async () => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    const linkPath = path.join(pluginRoot, "skills-link");
    await fs.mkdir(outsideSkills, { recursive: true });
    await fs.symlink(outsideSkills, linkPath, directorySymlinkType);

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills-link"],
      }),
    );

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(roots).toStrictEqual([]);
  });

  it.each([
    { state: "no workspace is active", activeWorkspace: false, config: {} },
    {
      state: "plugins are globally disabled",
      activeWorkspace: true,
      config: { plugins: { enabled: false, entries: { helper: { enabled: true } } } },
    },
  ])("cleans up generated plugin skill links when $state", async ({ activeWorkspace, config }) => {
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const staleRoot = await tempDirs.make("stale-plugin-skills-");
    const staleSkill = path.join(staleRoot, "stale-skill");
    await fs.mkdir(staleSkill, { recursive: true });
    fsSync.symlinkSync(staleSkill, path.join(pluginSkillsDir, "stale-skill"), directorySymlinkType);
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({ pluginRoot: staleRoot, skills: ["./stale-skill"] }),
    );

    const roots = resolvePluginSkillRoots({
      workspaceDir: activeWorkspace ? await tempDirs.make("openclaw-") : undefined,
      config,
      pluginSkillsDir,
    });

    expect(roots).toStrictEqual([]);
    await expectPathMissing(path.join(pluginSkillsDir, "stale-skill"));
    expect((await fs.stat(staleSkill)).isDirectory()).toBe(true);
    expect(hoisted.resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("limits Agent Plugins skills to valid immediate child directories", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginRoot = await tempDirs.make("openclaw-agent-bundle-");
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const skillsRoot = path.join(pluginRoot, "skills");
    const validSkill = path.join(skillsRoot, "valid");
    const nestedSkill = path.join(skillsRoot, "group", "deep");
    await fs.mkdir(validSkill, { recursive: true });
    await fs.mkdir(nestedSkill, { recursive: true });
    await fs.mkdir(path.join(skillsRoot, "missing"), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, "SKILL.md"), "root skill must be ignored\n");
    await fs.writeFile(path.join(validSkill, "SKILL.md"), "valid immediate skill\n");
    await fs.writeFile(path.join(nestedSkill, "SKILL.md"), "nested skill must be ignored\n");

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        format: "bundle",
        bundleFormat: "agent",
        skills: ["skills"],
      }),
    );

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      pluginSkillsDir,
      config: {
        plugins: { entries: { helper: { enabled: true } } },
      } as OpenClawConfig,
    });

    expect(roots).toEqual([{ dir: validSkill, rejectHardlinks: true }]);
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "valid"))).toBe(validSkill);
    expect(fsSync.existsSync(path.join(pluginSkillsDir, "deep"))).toBe(false);
    expect(fsSync.existsSync(path.join(pluginSkillsDir, "skills"))).toBe(false);
  });
});

describe("publishPluginSkills", () => {
  beforeAll(async () => {
    ({ resolvePluginSkillRoots } = await import("./plugin-skills.js"));
  });

  function publishPluginSkills(skillDirs: string[], opts: { pluginSkillsDir: string }): void {
    const plugins = skillDirs.map((rootDir, index) => ({
      id: `publish-test-${index}`,
      name: `Publish Test ${index}`,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: ["."],
      hooks: [],
      origin: "workspace" as const,
      rootDir,
      source: rootDir,
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    }));
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      diagnostics: [],
      plugins,
    });
    resolvePluginSkillRoots({
      workspaceDir: opts.pluginSkillsDir,
      pluginSkillsDir: opts.pluginSkillsDir,
      config: {
        plugins: {
          entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { enabled: true }])),
        },
      },
    });
  }

  function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  }

  async function writeSkillDir(
    parentDir: string,
    name: string,
    description = `${name} description`,
  ) {
    const dir = path.join(parentDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
    return dir;
  }

  it("replaces owned generated symlinks when the previous target disappeared", async () => {
    const staleParent = await tempDirs.make("plugin-skills-stale-");
    const currentParent = await tempDirs.make("plugin-skills-current-");
    const managedDir = await tempDirs.make("managed-skills-");

    const staleDir = await writeSkillDir(staleParent, "my-skill", "old");
    const currentDir = await writeSkillDir(currentParent, "my-skill", "new");
    const linkPath = path.join(managedDir, "my-skill");

    fsSync.symlinkSync(staleDir, linkPath, directorySymlinkType);
    await fs.rm(staleParent, { recursive: true, force: true });

    publishPluginSkills([currentDir], { pluginSkillsDir: managedDir });

    expect(fsSync.readlinkSync(linkPath)).toBe(currentDir);
  });

  it("replaces generated Windows directory entries before publishing a current skill", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "my-skill");
    const existingDir = path.join(managedDir, "my-skill");
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(path.join(existingDir, "stale.txt"), "stale");

    withPlatform("win32", () => {
      publishPluginSkills([dir], { pluginSkillsDir: managedDir });
    });

    expect(fsSync.readlinkSync(existingDir)).toBe(dir);
  });

  it.runIf(process.platform !== "win32")(
    "skips child skill directories whose SKILL.md symlinks outside the declared root",
    async () => {
      const skillParent = await tempDirs.make("plugin-skills-");
      const managedDir = await tempDirs.make("managed-skills-");
      const outsideDir = await tempDirs.make("outside-skill-file-");
      const parentDir = path.join(skillParent, "skills");
      const leakDir = path.join(parentDir, "leak");
      await fs.mkdir(leakDir, { recursive: true });
      await fs.writeFile(
        path.join(outsideDir, "SKILL.md"),
        "---\nname: leak\ndescription: Outside\n---\n",
      );
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(leakDir, "SKILL.md"));
      const validDir = await writeSkillDir(parentDir, "valid");

      publishPluginSkills([parentDir], { pluginSkillsDir: managedDir });

      expect(fsSync.existsSync(path.join(managedDir, "leak"))).toBe(false);
      expect(fsSync.readlinkSync(path.join(managedDir, "valid"))).toBe(validDir);
    },
  );

  it("handles collision: same basename from different plugins uses first one", async () => {
    const skillParent1 = await tempDirs.make("plugin-skills-1-");
    const skillParent2 = await tempDirs.make("plugin-skills-2-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir1 = await writeSkillDir(skillParent1, "shared-name", "first");
    const dir2 = await writeSkillDir(skillParent2, "shared-name", "second");

    publishPluginSkills([dir1, dir2], {
      pluginSkillsDir: managedDir,
    });

    // First one wins.
    expect(fsSync.readlinkSync(path.join(managedDir, "shared-name"))).toBe(dir1);
  });
});
