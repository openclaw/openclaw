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
const symlinkType = process.platform === "win32" ? "junction" : "dir";
const enabled = (...ids: string[]): OpenClawConfig => ({
  plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) },
});
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
function register(...plugins: PluginManifestRecord[]) {
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({ diagnostics: [], plugins });
}
async function write(dir: string, text = "# Skill\n") {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), text);
  return dir;
}
async function fixture() {
  const w = await tempDirs.make("plugin-skills-");
  const p = path.join(w, "plugin"),
    m = path.join(w, "managed"),
    o = path.join(w, "outside");
  await Promise.all([p, m, o].map((dir) => fs.mkdir(dir)));
  const s = path.join(p, "skills"),
    config = enabled("helper");
  return {
    w,
    p,
    m,
    o,
    s,
    config,
    use: (overrides: Partial<PluginManifestRecord> = {}) => register(makePlugin(p, overrides)),
    resolve: (nextConfig: OpenClawConfig = config) =>
      resolvePluginSkillRoots({ workspaceDir: w, pluginSkillsDir: m, config: nextConfig }),
    link: (name: string) => fsSync.readlinkSync(path.join(m, name)),
    missing: (name: string) =>
      expect(fs.lstat(path.join(m, name))).rejects.toMatchObject({ code: "ENOENT" }),
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReset();
  hoisted.loadPluginMetadataSnapshot.mockClear();
  hoisted.resolvePluginMetadataSnapshot.mockClear();
  hoisted.loadPluginRegistrySnapshot.mockReset();
  acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
  await tempDirs.cleanup();
});
function backend(available = true) {
  if (!available) {
    return acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
  }
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
async function acpFixture(stable = false) {
  await Promise.all([f.p, f.o].map((dir) => fs.mkdir(path.join(dir, "skills"))));
  const manifestRegistry: PluginManifestRegistry = {
    diagnostics: [],
    plugins: [makePlugin(f.p, { id: "acpx", name: "ACPX Runtime" }), makePlugin(f.o)],
  };
  register(...manifestRegistry.plugins);
  if (stable) {
    const snapshot = {
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      normalizePluginId: (id: string) =>
        manifestRegistry.plugins.find((p) => p.legacyPluginIds?.includes(id))?.id ?? id,
    };
    for (let i = 0; i < 3; i++) {
      hoisted.loadPluginMetadataSnapshot.mockReturnValueOnce(snapshot);
    }
  }
  return (available: boolean) => [
    ...(available ? [path.join(f.p, "skills")] : []),
    path.join(f.o, "skills"),
  ];
}

describe("resolvePluginSkillRoots", () => {
  beforeEach(() => {
    register();
    hoisted.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
  });
  it("keeps package targets stable across config changes while publishing live selection", async () => {
    const original = await write(path.join(f.s, "original"));
    f.use();
    f.resolve();
    expect(f.link("original")).toBe(original);
    const added = await write(path.join(f.s, "added"));
    f.resolve({ ...f.config });
    await f.missing("added");
    withPluginCache(createPluginCache(), () => f.resolve({ ...f.config }));
    expect(f.link("added")).toBe(added);
    f.resolve({ ...f.config });
    await f.missing("added");
    f.resolve({ plugins: { entries: { helper: { enabled: false } } } });
    await f.missing("original");
  });
  it("honors a disabled manifest channel with a different plugin id", async () => {
    await fs.mkdir(f.s);
    f.use({ id: "openclaw-demo", name: "Demo", channels: ["demo"], origin: "bundled" });
    expect(
      f
        .resolve({
          channels: { demo: { enabled: false } },
          plugins: { entries: { "openclaw-demo": { enabled: true } } },
        } as OpenClawConfig)
        .map((root) => root.dir),
    ).toEqual([]);
  });
  it("skips acpx skills when ACP is disabled", async () => {
    const dirs = await acpFixture();
    backend();
    expect(
      f.resolve({ acp: { enabled: false }, ...enabled("acpx", "helper") }).map((root) => root.dir),
    ).toEqual(dirs(false));
  });
  it.each([false, true])(
    "invalidates stable inputs when ACP availability changes from %s",
    async (initial) => {
      const dirs = await acpFixture(true);
      const config = { acp: { enabled: true }, ...enabled("acpx", "helper") };
      backend(initial);
      const first = f.resolve(config);
      backend(!initial);
      const second = f.resolve(config);
      expect(first.map((root) => root.dir)).toEqual(dirs(initial));
      expect(second.map((root) => root.dir)).toEqual(dirs(!initial));
      expect(f.resolve(config)).toEqual(second);
    },
  );
  it("publishes links in each private state scope through the workspace loader", async () => {
    const skill = await write(
      path.join(f.s, "helper"),
      "---\nname: helper\ndescription: Helper\n---\n",
    );
    f.use();
    const roots = resolvePluginInstallRoots();
    for (const name of ["first", "second"]) {
      const stateDir = path.join(f.w, name);
      withPluginInstallRoots({ ...roots, stateDir }, () =>
        loadWorkspaceSkills(f.w, { config: f.config }),
      );
      expect(await fs.readlink(path.join(stateDir, "plugin-skills", "helper"))).toBe(skill);
    }
  });
  it.each([false, true])("rejects plugin root escapes (symlink=%s)", async (symlink) => {
    const outside = path.join(f.o, "skills");
    await fs.mkdir(outside);
    if (symlink) {
      await fs.symlink(outside, path.join(f.p, "skills-link"), symlinkType);
    } else {
      await fs.mkdir(f.s);
    }
    f.use({ skills: symlink ? ["./skills-link"] : ["./skills", path.relative(f.p, outside)] });
    expect(f.resolve()).toStrictEqual(symlink ? [] : [{ dir: f.s, rejectHardlinks: true }]);
  });
  it.each([false, true])("cleans generated links (active workspace=%s)", async (active) => {
    const stale = path.join(f.o, "stale-skill");
    await fs.mkdir(stale);
    fsSync.symlinkSync(stale, path.join(f.m, "stale-skill"), symlinkType);
    register(makePlugin(f.o, { skills: ["./stale-skill"] }));
    expect(
      resolvePluginSkillRoots({
        workspaceDir: active ? f.w : undefined,
        pluginSkillsDir: f.m,
        config: active
          ? { plugins: { enabled: false, entries: { helper: { enabled: true } } } }
          : {},
      }),
    ).toStrictEqual([]);
    await f.missing("stale-skill");
    expect((await fs.stat(stale)).isDirectory()).toBe(true);
    expect(hoisted.resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
  });
  it("limits Agent Plugins skills to valid immediate child directories", async () => {
    const valid = await write(path.join(f.s, "valid"), "valid immediate skill\n");
    await write(path.join(f.s, "group", "deep"), "nested skill must be ignored\n");
    await fs.mkdir(path.join(f.s, "missing"));
    await fs.writeFile(path.join(f.s, "SKILL.md"), "root skill must be ignored\n");
    f.use({ format: "bundle", bundleFormat: "agent", skills: ["skills"] });
    expect(f.resolve()).toEqual([{ dir: valid, rejectHardlinks: true }]);
    expect(f.link("valid")).toBe(valid);
    expect(["deep", "skills"].map((name) => fsSync.existsSync(path.join(f.m, name)))).toEqual([
      false,
      false,
    ]);
  });
});

describe("publishPluginSkills", () => {
  function publish(...dirs: string[]) {
    const plugins = dirs.map((dir, i) =>
      makePlugin(dir, {
        id: `publish-test-${i}`,
        name: `Publish Test ${i}`,
        skills: ["."],
      }),
    );
    register(...plugins);
    f.resolve(enabled(...plugins.map((p) => p.id)));
  }
  const skill = (name: string, dir = f.p, description = name) =>
    write(
      path.join(dir, name),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
  it.each(["missing symlink target", "Windows directory"])(
    "replaces a generated %s",
    async (kind) => {
      const current = await skill("my-skill", f.p, "new");
      const entry = path.join(f.m, "my-skill");
      if (kind === "missing symlink target") {
        const stale = await skill("my-skill", f.o, "old");
        fsSync.symlinkSync(stale, entry, symlinkType);
        await fs.rm(f.o, { recursive: true, force: true });
        publish(current);
      } else {
        await fs.mkdir(entry);
        await fs.writeFile(path.join(entry, "stale.txt"), "stale");
        const platform = process.platform;
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        try {
          publish(current);
        } finally {
          Object.defineProperty(process, "platform", { configurable: true, value: platform });
        }
      }
      expect(f.link("my-skill")).toBe(current);
    },
  );
  it.runIf(process.platform !== "win32")(
    "rejects child SKILL.md symlinks outside the declared root",
    async () => {
      const leak = path.join(f.s, "leak");
      await fs.mkdir(leak, { recursive: true });
      await fs.writeFile(
        path.join(f.o, "SKILL.md"),
        "---\nname: leak\ndescription: Outside\n---\n",
      );
      await fs.symlink(path.join(f.o, "SKILL.md"), path.join(leak, "SKILL.md"));
      const valid = await skill("valid", f.s);
      publish(f.s);
      expect(fsSync.existsSync(path.join(f.m, "leak"))).toBe(false);
      expect(f.link("valid")).toBe(valid);
    },
  );
  it("uses the first plugin when basenames collide", async () => {
    const first = await skill("shared-name", f.p, "first");
    publish(first, await skill("shared-name", f.o, "second"));
    expect(f.link("shared-name")).toBe(first);
  });
});
