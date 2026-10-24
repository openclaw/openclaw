import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { captureEnv } from "../test-utils/env.js";

// src/plugins/bundled-dir.test.ts owns source/dist directory precedence.
vi.mock("../plugins/bundled-dir.js", () => ({
  resolveBundledPluginsDir: vi.fn(),
  resolveSourceCheckoutDependencyDiagnostic: vi.fn(() => null),
}));

// mock-isolation: prove bundled metadata reads do not invoke full plugin discovery.
vi.mock("../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: vi.fn(() => {
    throw new Error("bundled channel catalog read must not run full plugin discovery");
  }),
}));

// mock-isolation: only the temporary catalog entries belong to this fixture.
vi.mock("../plugins/official-external-plugin-bundled-catalogs.js", () => ({
  BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES: [],
}));

// Isolate package-root discovery to the temporary cwd, not this source checkout.
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
  resolveOpenClawPackageRoot: async (opts: { cwd?: string; argv1?: string; moduleUrl?: string }) =>
    opts.cwd ?? null,
}));

import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  findBundledChannelCatalogMetadata,
  listBundledChannelCatalogEntries,
} from "./bundled-channel-catalog-read.js";

const tempDirs: string[] = [];
const originalEnv = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
]);

afterEach(() => {
  originalEnv.restore();
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
});

function useBundledPluginsDir(extensionsRoot: string | undefined): void {
  if (extensionsRoot) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = extensionsRoot;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  } else {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  }
  vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);
}

function seedRoot(prefix: string): string {
  const root = makeTempRepoRoot(tempDirs, prefix);
  writeJsonFile(path.join(root, "package.json"), { name: "openclaw" });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
}

function channelPackage(
  id: string,
  label: string,
  doctorCapabilities?: PluginPackageChannel["doctorCapabilities"],
) {
  const channel = {
    id,
    label,
    docsPath: `/channels/${id}`,
    blurb: "test blurb",
    doctorCapabilities,
  };
  return { name: `@openclaw/${id}`, openclaw: { channel } };
}

const channelLabel = (id: string) =>
  listBundledChannelCatalogEntries().find((entry) => entry.id === id)?.channel.label;

it("finds doctor capabilities from the generated catalog when the package is excluded", () => {
  const root = seedRoot("bcr-generated-doctor-");
  useBundledPluginsDir(undefined);
  const doctorCapabilities = {
    dmAllowFromMode: "topOnly",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false,
  } satisfies PluginPackageChannel["doctorCapabilities"];
  writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
    entries: [channelPackage("discord", "Discord", doctorCapabilities)],
  });

  expect(findBundledChannelCatalogMetadata("Discord")?.doctorCapabilities).toEqual(
    doctorCapabilities,
  );
});
it("reloads installed bundled package metadata after an explicit plugin lifecycle reset", () => {
  const root = seedRoot("bcr-package-lifecycle-");
  const extensionsRoot = path.join(root, "dist", "extensions");
  const packagePath = path.join(extensionsRoot, "alpha", "package.json");
  writeJsonFile(packagePath, channelPackage("alpha", "Before"));
  useBundledPluginsDir(extensionsRoot);

  expect(channelLabel("alpha")).toBe("Before");
  writeJsonFile(packagePath, channelPackage("alpha", "After"));
  clearPluginMetadataLifecycleCaches();

  expect(channelLabel("alpha")).toBe("After");
});
