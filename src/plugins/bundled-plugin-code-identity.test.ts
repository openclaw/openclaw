import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import type { BuildProvenance } from "../version.js";
import { getPluginInstanceCodeIdentity } from "./plugin-code-identity.js";
import { createTestInstance } from "./plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord } from "./registry-types.js";
import { createPluginRecord } from "./status.test-helpers.js";

const loadedBuild = vi.hoisted((): { value: BuildProvenance | null } => ({ value: null }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildProvenance: () => loadedBuild.value,
}));

function readIdentity(
  plugin: Pick<PluginRecord, "id" | "source" | "rootDir">,
  build: BuildProvenance | null,
) {
  loadedBuild.value = build;
  const record = createPluginRecord({ ...plugin, origin: "bundled" });
  const registry = { ...createEmptyPluginRegistry(), plugins: [record] };
  createTestInstance(record.id, { record, registry });
  return getPluginInstanceCodeIdentity(record);
}

const roots = createSuiteTempRootTracker({ prefix: "openclaw-bundled-code-identity-" });
beforeAll(() => roots.setup());
afterAll(() => roots.cleanup());

const record = {
  buildId: "2026.10.22-0123456789ab-2026-10-22T00-00-00.000Z",
  version: "2026.10.22",
  commit: "0123456789abcdef0123456789abcdef01234567",
  builtAt: "2026-10-22T00:00:00.000Z",
};

/** A built package: `dist/build-info.json` plus bundled plugin trees in its own build output. */
async function builtPackage() {
  const root = await fs.realpath(await roots.make("package"));
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  const buildInfoPath = path.join(root, "dist", "build-info.json");
  await fs.writeFile(buildInfoPath, JSON.stringify(record));
  const plugin = async (...segments: string[]) => {
    const rootDir = path.join(root, ...segments);
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, "index.js"), "module.exports = {};\n");
    return { id: "watcher", rootDir, source: path.join(rootDir, "index.js") };
  };
  return { root, build: { ...record, buildInfoPath }, plugin };
}

describe("core-bundled plugin code identity", () => {
  it("is stable for the same plugin in the same build and changes with the build", async () => {
    const pkg = await builtPackage();
    const plugin = await pkg.plugin("dist", "extensions", "watcher");
    const identity = readIdentity(plugin, pkg.build);
    expect(identity).toMatch(/^bundled-build:[0-9a-f]{64}$/u);
    expect(readIdentity({ ...plugin }, { ...pkg.build })).toBe(identity);
    // An upgrade, downgrade or rebuild writes another build ID: never the same identity.
    const rebuilt = { ...pkg.build, buildId: pkg.build.buildId + "-rebuilt" };
    expect(readIdentity(plugin, rebuilt)).toMatch(/^bundled-build:/u);
    expect(readIdentity(plugin, rebuilt)).not.toBe(identity);
    // Another plugin ID in the same tree is other code.
    expect(readIdentity({ ...plugin, id: "other" }, pkg.build)).not.toBe(identity);
  });

  it("distinguishes builds that share an explicit build ID", async () => {
    // OPENCLAW_CONTROL_UI_BUILD_ID replaces the build ID, not the build time or commit.
    const pkg = await builtPackage();
    const plugin = await pkg.plugin("dist", "extensions", "watcher");
    const identity = readIdentity(plugin, pkg.build);
    const later = { ...pkg.build, builtAt: "2026-10-22T00:00:01.000Z" };
    const otherCommit = { ...pkg.build, commit: "f".repeat(40) };
    const otherVersion = { ...pkg.build, version: "2026.10.23" };
    const identities = [later, otherCommit, otherVersion].map((build) =>
      readIdentity(plugin, build),
    );
    for (const other of identities) {
      expect(other).toMatch(/^bundled-build:/u);
      expect(other).not.toBe(identity);
    }
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("covers the runtime overlay the build writes beside dist", async () => {
    const pkg = await builtPackage();
    const dist = await pkg.plugin("dist", "extensions", "watcher");
    const overlay = await pkg.plugin("dist-runtime", "extensions", "watcher");
    const overlayIdentity = readIdentity(overlay, pkg.build);
    expect(overlayIdentity).toMatch(/^bundled-build:/u);
    expect(overlayIdentity).not.toBe(readIdentity(dist, pkg.build));
  });

  it("has no identity without loaded build provenance", async () => {
    const pkg = await builtPackage();
    const plugin = await pkg.plugin("dist", "extensions", "watcher");
    expect(readIdentity(plugin, null)).toBeUndefined();
    // A record without the build time every build writes is not a build's own record.
    const { builtAt: _builtAt, ...untimed } = pkg.build;
    expect(readIdentity(plugin, untimed)).toBeUndefined();
    // A build ID whose record has no file location cannot place the plugin inside that build.
    expect(readIdentity(plugin, { buildId: pkg.build.buildId })).toBe(undefined);
    // Provenance that is not the build's own dist record does not describe this output.
    const stray = { ...pkg.build, buildInfoPath: path.join(pkg.root, "build-info.json") };
    expect(readIdentity(plugin, stray)).toBeUndefined();
    expect(readIdentity({ ...plugin, rootDir: undefined }, pkg.build)).toBe(undefined);
  });

  it("has no identity for bundled code outside the build's output", async () => {
    const pkg = await builtPackage();
    // A source checkout's extensions and an override directory can change without a rebuild.
    const source = await pkg.plugin("extensions", "watcher");
    const override = await pkg.plugin("plugins-override", "watcher");
    expect(readIdentity(source, pkg.build)).toBeUndefined();
    expect(readIdentity(override, pkg.build)).toBeUndefined();
    // So is another package's build output.
    const other = await builtPackage();
    const foreign = await other.plugin("dist", "extensions", "watcher");
    expect(readIdentity(foreign, pkg.build)).toBeUndefined();
    // The extensions directory itself is not a plugin root.
    const extensions = path.join(pkg.root, "dist", "extensions");
    expect(
      readIdentity(
        {
          id: "watcher",
          rootDir: extensions,
          source: path.join(extensions, "watcher", "index.js"),
        },
        pkg.build,
      ),
    ).toBeUndefined();
  });

  it("resolves links before deciding what code a path names", async () => {
    const pkg = await builtPackage();
    const plugin = await pkg.plugin("dist", "extensions", "watcher");
    const outside = await pkg.plugin("outside", "watcher");
    // A link inside dist that points at mutable code elsewhere is not build output.
    const linked = path.join(pkg.root, "dist", "extensions", "linked");
    await fs.symlink(outside.rootDir, linked, "dir");
    expect(
      readIdentity(
        { id: "watcher", rootDir: linked, source: path.join(linked, "index.js") },
        pkg.build,
      ),
    ).toBeUndefined();
    // An entry outside the plugin's own root does not belong to it.
    expect(readIdentity({ ...plugin, source: outside.source }, pkg.build)).toBeUndefined();
    // A missing entry or root has nothing to identify.
    expect(
      readIdentity({ ...plugin, source: path.join(plugin.rootDir, "missing.js") }, pkg.build),
    ).toBeUndefined();
  });
});
