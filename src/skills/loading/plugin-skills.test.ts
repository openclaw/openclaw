import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing as acpRuntimeTesting,
  registerAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "../../plugins/install-root-context.js";
import type {
  PluginManifestRecord,
  PluginManifestRegistry,
} from "../../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resolvePluginSkillRoots } from "./plugin-skills.js";
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

const tempDirs = createTrackedTempDirs();
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function makePlugin(
  rootDir: string,
  overrides: Partial<PluginManifestRecord> = {},
): PluginManifestRecord {
  return {
    id: "helper",
    name: "Helper",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: ["./skills"],
    hooks: [],
    origin: "workspace",
    rootDir,
    source: rootDir,
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    ...overrides,
  };
}

const enabledConfig = (...ids: string[]): OpenClawConfig => ({
  plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) },
});

async function writeRawSkill(dir: string, content: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content);
}

function buildRegistry(params: { acpxRoot: string; helperRoot: string }): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      makePlugin(params.acpxRoot, { id: "acpx", name: "ACPX Runtime" }),
      makePlugin(params.helperRoot),
    ],
  };
}

function register(...plugins: PluginManifestRecord[]) {
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({ diagnostics: [], plugins });
}

function registerPlugin(root: string, overrides: Partial<PluginManifestRecord> = {}) {
  register(makePlugin(root, overrides));
}

async function setupAcpxAndHelperRegistry() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const acpxRoot = await tempDirs.make("openclaw-acpx-plugin-");
  const helperRoot = await tempDirs.make("openclaw-helper-plugin-");
  await fs.mkdir(path.join(acpxRoot, "skills"), { recursive: true });
  await fs.mkdir(path.join(helperRoot, "skills"), { recursive: true });
  register(...buildRegistry({ acpxRoot, helperRoot }).plugins);
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
  return { workspaceDir, pluginRoot, outsideSkills: path.join(outsideDir, "skills") };
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
  beforeEach(() => {
    register();
    hoisted.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
  });

  it("keeps package skill targets stable across config changes while publishing live selection", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await tempDirs.make("openclaw-plugin-");
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const skillsRoot = path.join(pluginRoot, "skills");
    const original = path.join(skillsRoot, "original");
    const added = path.join(skillsRoot, "added");
    await writeRawSkill(original, "# Original\n");
    registerPlugin(pluginRoot);
    const config = enabledConfig("helper");
    const resolve = (nextConfig = config) =>
      resolvePluginSkillRoots({ workspaceDir, config: nextConfig, pluginSkillsDir });
    resolve();
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "original"))).toBe(original);

    await writeRawSkill(added, "# Added\n");
    resolve({ ...config });
    await expectPathMissing(path.join(pluginSkillsDir, "added"));

    withPluginCache(createPluginCache(), () => resolve({ ...config }));
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "added"))).toBe(added);
    resolve({ ...config });
    await expectPathMissing(path.join(pluginSkillsDir, "added"));

    resolve({ plugins: { entries: { helper: { enabled: false } } } });
    await expectPathMissing(path.join(pluginSkillsDir, "original"));
  });

  it("honors a disabled manifest channel whose id differs from the plugin id", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginRoot = await tempDirs.make("openclaw-demo-plugin-");
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    registerPlugin(pluginRoot, {
      id: "openclaw-demo",
      name: "Demo",
      channels: ["demo"],
      origin: "bundled",
    });

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        channels: { demo: { enabled: false } },
        plugins: { entries: { "openclaw-demo": { enabled: true } } },
      } as OpenClawConfig,
    });

    expect(roots.map((root) => root.dir)).toEqual([]);
  });

  it("skips acpx plugin skills when ACP is disabled", async () => {
    const { workspaceDir, helperRoot } = await setupAcpxAndHelperRegistry();
    registerHealthyAcpBackend();
    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        acp: { enabled: false },
        ...enabledConfig("acpx", "helper"),
      },
    });
    expect(roots.map((root) => root.dir)).toEqual([path.resolve(helperRoot, "skills")]);
  });

  it.each([false, true])(
    "invalidates the memo when ACP availability changes from %s with stable inputs",
    async (initiallyAvailable) => {
      const { workspaceDir, acpxRoot, helperRoot } = await setupAcpxAndHelperRegistry();
      const manifestRegistry = buildRegistry({ acpxRoot, helperRoot });
      useStableMetadataSnapshot(manifestRegistry);
      const config = { acp: { enabled: true }, ...enabledConfig("acpx", "helper") };
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
      expect(first.map((root) => root.dir)).toEqual(dirsForState(initiallyAvailable));
      expect(second.map((root) => root.dir)).toEqual(dirsForState(!initiallyAvailable));
      expect(resolvePluginSkillRoots({ workspaceDir, config })).toEqual(second);
    },
  );

  it("publishes generated links in each active private state scope through the workspace loader", async () => {
    const workspaceDir = await tempDirs.make("openclaw-private-skills-");
    const pluginRoot = await tempDirs.make("openclaw-plugin-");
    const skillDir = path.join(pluginRoot, "skills", "helper");
    await writeRawSkill(skillDir, "---\nname: helper\ndescription: Helper\n---\n");
    registerPlugin(pluginRoot);
    const roots = resolvePluginInstallRoots();
    for (const name of ["first", "second"]) {
      const stateDir = path.join(workspaceDir, name);
      const config = enabledConfig("helper");
      withPluginInstallRoots({ ...roots, stateDir }, () => {
        loadWorkspaceSkills(workspaceDir, { config });
      });
      expect(await fs.readlink(path.join(stateDir, "plugin-skills", "helper"))).toBe(skillDir);
    }
  });

  it.each([false, true])("rejects plugin root escapes (symlink=%s)", async (symlink) => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    await fs.mkdir(outsideSkills, { recursive: true });
    const safe = path.join(pluginRoot, "skills");
    if (symlink) {
      await fs.symlink(outsideSkills, path.join(pluginRoot, "skills-link"), directorySymlinkType);
    } else {
      await fs.mkdir(safe, { recursive: true });
    }
    registerPlugin(pluginRoot, {
      skills: symlink ? ["./skills-link"] : ["./skills", path.relative(pluginRoot, outsideSkills)],
    });
    const roots = resolvePluginSkillRoots({ workspaceDir, config: enabledConfig("helper") });
    expect(roots).toStrictEqual(symlink ? [] : [{ dir: safe, rejectHardlinks: true }]);
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
    registerPlugin(staleRoot, { skills: ["./stale-skill"] });

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
    await writeRawSkill(validSkill, "valid immediate skill\n");
    await writeRawSkill(nestedSkill, "nested skill must be ignored\n");
    await fs.mkdir(path.join(skillsRoot, "missing"), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, "SKILL.md"), "root skill must be ignored\n");

    registerPlugin(pluginRoot, {
      format: "bundle",
      bundleFormat: "agent",
      skills: ["skills"],
    });

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      pluginSkillsDir,
      config: enabledConfig("helper"),
    });

    expect(roots).toEqual([{ dir: validSkill, rejectHardlinks: true }]);
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "valid"))).toBe(validSkill);
    expect(fsSync.existsSync(path.join(pluginSkillsDir, "deep"))).toBe(false);
    expect(fsSync.existsSync(path.join(pluginSkillsDir, "skills"))).toBe(false);
  });
});

describe("publishPluginSkills", () => {
  function publishPluginSkills(skillDirs: string[], pluginSkillsDir: string): void {
    const plugins = skillDirs.map((rootDir, index) =>
      makePlugin(rootDir, {
        id: `publish-test-${index}`,
        name: `Publish Test ${index}`,
        skills: ["."],
      }),
    );
    register(...plugins);
    resolvePluginSkillRoots({
      workspaceDir: pluginSkillsDir,
      pluginSkillsDir,
      config: enabledConfig(...plugins.map((plugin) => plugin.id)),
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

  async function writeSkillDir(parentDir: string, name: string, description = name) {
    const dir = path.join(parentDir, name);
    await writeRawSkill(dir, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
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

    publishPluginSkills([currentDir], managedDir);

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
      publishPluginSkills([dir], managedDir);
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

      publishPluginSkills([parentDir], managedDir);

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

    publishPluginSkills([dir1, dir2], managedDir);

    expect(fsSync.readlinkSync(path.join(managedDir, "shared-name"))).toBe(dir1);
  });
});
