import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
  target: Pick<PluginRecord, "id" | "source" | "rootDir"> = plugin,
  build: BuildProvenance | null = pkg.build,
) {
  loadedBuild.value = build;
  const record = createPluginRecord({ ...target, origin: "bundled" });
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

let pkg: Awaited<ReturnType<typeof builtPackage>>;
let plugin: Awaited<ReturnType<typeof pkg.plugin>>;
beforeEach(async () => {
  pkg = await builtPackage();
  plugin = await pkg.plugin("dist", "extensions", "watcher");
});

it("is stable for the same plugin in the same build and changes with the build", () => {
  const identity = readIdentity();
  expect(identity).toMatch(/^bundled-build:[0-9a-f]{64}$/u);
  expect(readIdentity({ ...plugin }, { ...pkg.build })).toBe(identity);
  const rebuilt = { ...pkg.build, buildId: pkg.build.buildId + "-rebuilt" };
  expect(readIdentity(plugin, rebuilt)).toMatch(/^bundled-build:/u);
  expect(readIdentity(plugin, rebuilt)).not.toBe(identity);
  expect(readIdentity({ ...plugin, id: "other" })).not.toBe(identity);
});

it("distinguishes builds that share an explicit build ID", () => {
  // OPENCLAW_CONTROL_UI_BUILD_ID replaces the build ID, not the build time or commit.
  const identity = readIdentity();
  const identities = (["builtAt", "commit", "version"] as const).map((field) =>
    readIdentity(plugin, { ...pkg.build, [field]: `${pkg.build[field]}-changed` }),
  );
  for (const other of identities) {
    expect(other).toMatch(/^bundled-build:/u);
    expect(other).not.toBe(identity);
  }
  expect(new Set(identities).size).toBe(identities.length);
});

it("covers the runtime overlay the build writes beside dist", async () => {
  const overlay = await pkg.plugin("dist-runtime", "extensions", "watcher");
  const overlayIdentity = readIdentity(overlay);
  expect(overlayIdentity).toMatch(/^bundled-build:/u);
  expect(overlayIdentity).not.toBe(readIdentity());
});

it("has no identity without loaded build provenance", () => {
  expect(readIdentity(plugin, null)).toBeUndefined();
  const { builtAt: _builtAt, ...untimed } = pkg.build;
  expect(readIdentity(plugin, untimed)).toBeUndefined();
  expect(readIdentity(plugin, { buildId: pkg.build.buildId })).toBe(undefined);
  const stray = { ...pkg.build, buildInfoPath: path.join(pkg.root, "build-info.json") };
  expect(readIdentity(plugin, stray)).toBeUndefined();
  expect(readIdentity({ ...plugin, rootDir: undefined })).toBe(undefined);
});

it("has no identity for bundled code outside the build's output", async () => {
  const source = await pkg.plugin("extensions", "watcher");
  const override = await pkg.plugin("plugins-override", "watcher");
  expect(readIdentity(source)).toBeUndefined();
  expect(readIdentity(override)).toBeUndefined();
  const other = await builtPackage();
  const foreign = await other.plugin("dist", "extensions", "watcher");
  expect(readIdentity(foreign)).toBeUndefined();
  const extensions = path.join(pkg.root, "dist", "extensions");
  expect(readIdentity({ ...plugin, rootDir: extensions })).toBeUndefined();
});

it("resolves links before deciding what code a path names", async () => {
  const outside = await pkg.plugin("outside", "watcher");
  // A link inside dist that points at mutable code elsewhere is not build output.
  const linked = path.join(pkg.root, "dist", "extensions", "linked");
  await fs.symlink(outside.rootDir, linked, "dir");
  expect(
    readIdentity({ id: "watcher", rootDir: linked, source: path.join(linked, "index.js") }),
  ).toBeUndefined();
  expect(readIdentity({ ...plugin, source: outside.source })).toBeUndefined();
  expect(
    readIdentity({ ...plugin, source: path.join(plugin.rootDir, "missing.js") }),
  ).toBeUndefined();
});
