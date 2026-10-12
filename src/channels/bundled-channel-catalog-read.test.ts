import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { PluginChannelCatalogEntry } from "../plugins/channel-catalog-registry.js";
import { captureEnv } from "../test-utils/env.js";

// src/plugins/bundled-dir.test.ts owns source/dist directory precedence.
vi.mock("../plugins/bundled-dir.js", () => ({
  resolveBundledPluginsDir: vi.fn(),
  resolveSourceCheckoutDependencyDiagnostic: vi.fn(() => null),
}));

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => {
    throw new Error("bundled channel catalog read must not run full plugin discovery");
  }),
);

vi.mock("../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

const bundledOfficialExternalCatalogEntriesMock = vi.hoisted((): unknown[] => []);

vi.mock("../plugins/official-external-plugin-bundled-catalogs.js", () => ({
  BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES: bundledOfficialExternalCatalogEntriesMock,
}));

// The channel-catalog.json fallback still walks package roots via
// resolveOpenClawPackageRootSync. Isolate from the real repo by mocking
// moduleUrl/argv1 resolution to null and deriving only from the tmp cwd.
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
  bundledOfficialExternalCatalogEntriesMock.length = 0;
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
  listChannelCatalogEntriesMock.mockReset();
  listChannelCatalogEntriesMock.mockImplementation(() => {
    throw new Error("bundled channel catalog read must not run full plugin discovery");
  });
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

function seedChannelPkg(
  pkgJsonPath: string,
  opts: {
    id: string;
    label?: string;
  },
): void {
  writeJsonFile(pkgJsonPath, {
    name: `@openclaw/${opts.id}`,
    openclaw: {
      channel: {
        id: opts.id,
        label: opts.label ?? opts.id,
        docsPath: `/channels/${opts.id}`,
        blurb: "test blurb",
      },
    },
  });
}

function seedGeneratedChannelCatalog(
  root: string,
  params: {
    packageName: string;
    id: string;
    label: string;
    docsPath: string;
    blurb: string;
    doctorCapabilities?: {
      dmAllowFromMode?: "topOnly" | "nestedOnly";
      groupModel?: "sender" | "route" | "hybrid";
      groupAllowFromFallbackToAllowFrom?: boolean;
      warnOnEmptyGroupSenderAllowlist?: boolean;
    };
  },
): void {
  const { packageName, ...channel } = params;
  writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
    entries: [{ name: packageName, openclaw: { channel } }],
  });
}

describe("listBundledChannelCatalogEntries", () => {
  it("finds doctor capabilities from the generated catalog when the package is excluded", () => {
    const root = seedRoot("bcr-generated-doctor-");
    useBundledPluginsDir(undefined);
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/discord",
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
      blurb: "downloadable channel",
      doctorCapabilities: {
        dmAllowFromMode: "topOnly",
        groupModel: "route",
        groupAllowFromFallbackToAllowFrom: false,
        warnOnEmptyGroupSenderAllowlist: false,
      },
    });

    expect(findBundledChannelCatalogMetadata("Discord")?.doctorCapabilities).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    });
  });

  it("reloads installed bundled package metadata after an explicit plugin lifecycle reset", () => {
    const root = seedRoot("bcr-package-lifecycle-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    const packagePath = path.join(extensionsRoot, "alpha", "package.json");
    seedChannelPkg(packagePath, { id: "alpha", label: "Before" });
    useBundledPluginsDir(extensionsRoot);

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "alpha")?.channel.label,
    ).toBe("Before");
    seedChannelPkg(packagePath, { id: "alpha", label: "After" });
    clearPluginMetadataLifecycleCaches();

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "alpha")?.channel.label,
    ).toBe("After");
  });

  it("discovers a generated catalog created after an explicit plugin lifecycle reset", () => {
    const root = seedRoot("bcr-generated-lifecycle-");
    useBundledPluginsDir(undefined);

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "generated"),
    ).toBeUndefined();
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/generated",
      id: "generated",
      label: "Generated after reset",
      docsPath: "/channels/generated",
      blurb: "generated channel",
    });
    clearPluginMetadataLifecycleCaches();

    expect(
      listBundledChannelCatalogEntries().find((entry) => entry.id === "generated")?.channel.label,
    ).toBe("Generated after reset");
  });
});
