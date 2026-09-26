import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { PluginChannelCatalogEntry } from "../plugins/channel-catalog-registry.js";

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
import { listBundledChannelIds } from "./plugins/bundled-ids.js";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

afterEach(() => {
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
  }
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
    pluginId?: string;
    docsPath?: string;
    label?: string;
    blurb?: string;
    markdownCapable?: boolean;
    approvalFlags?: readonly ["native"];
  },
): void {
  const pluginId = opts.pluginId ?? opts.id;
  writeJsonFile(pkgJsonPath, {
    name: `@openclaw/${pluginId}`,
    openclaw: {
      channel: {
        id: opts.id,
        label: opts.label ?? opts.id,
        docsPath: opts.docsPath ?? `/channels/${opts.id}`,
        blurb: opts.blurb ?? "test blurb",
        ...(opts.markdownCapable !== undefined ? { markdownCapable: opts.markdownCapable } : {}),
        ...(opts.approvalFlags ? { approvalFlags: opts.approvalFlags } : {}),
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
  it("reads bundled channel metadata from the extensions dir returned by resolveBundledPluginsDir", () => {
    // Published CLIs use dist/extensions even without a generated catalog.
    const root = seedRoot("bcr-resolved-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "telegram", "package.json"), {
      id: "telegram",
      label: "Telegram",
      approvalFlags: ["native"],
    });
    seedChannelPkg(path.join(extensionsRoot, "imessage", "package.json"), {
      id: "imessage",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();

    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.has("imessage")).toBe(true);
    expect(ids.has("telegram")).toBe(true);
    const telegram = entries.find((entry) => entry.id === "telegram");
    expect(telegram?.channel.docsPath).toBe("/channels/telegram");
    expect(telegram?.channel.label).toBe("Telegram");
    expect(telegram?.channel.approvalFlags).toEqual(["native"]);
  });

  it("lists sorted bundled channel ids without substituting plugin ids", () => {
    const root = seedRoot("bcr-channel-ids-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "vendor-beta", "package.json"), {
      id: "beta-chat",
      pluginId: "vendor-beta-plugin",
    });
    seedChannelPkg(path.join(extensionsRoot, "vendor-alpha", "package.json"), {
      id: "alpha-chat",
      pluginId: "vendor-alpha-plugin",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries().filter(
      (entry) => entry.id === "alpha-chat" || entry.id === "beta-chat",
    );
    expect(entries).toHaveLength(2);
    listChannelCatalogEntriesMock.mockReturnValue(
      entries.map((entry) => ({
        pluginId: entry.id === "alpha-chat" ? "vendor-alpha-plugin" : "vendor-beta-plugin",
        origin: "bundled",
        rootDir: extensionsRoot,
        channel: entry.channel,
      })),
    );

    const ids = listBundledChannelIds(process.env);
    expect(ids).toEqual(["alpha-chat", "beta-chat"]);
    expect(ids).not.toContain("vendor-alpha-plugin");
    expect(ids).not.toContain("vendor-beta-plugin");
  });

  it("merges the generated official catalog with bundled package metadata", () => {
    const root = seedRoot("bcr-generated-official-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "telegram", "package.json"), {
      id: "telegram",
      label: "Telegram",
    });
    seedGeneratedChannelCatalog(root, {
      packageName: "@tencent-connect/openclaw-qqbot",
      id: "qqbot",
      label: "QQ Bot",
      docsPath: "/channels/qqbot",
      blurb: "downloadable channel",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.has("qqbot")).toBe(true);
    expect(ids.has("telegram")).toBe(true);
  });

  it("uses bundled external channel metadata before a dist catalog exists", () => {
    seedRoot("bcr-bundled-external-");
    bundledOfficialExternalCatalogEntriesMock.push({
      name: "@tencent-connect/openclaw-qqbot",
      openclaw: {
        channel: {
          id: "qqbot",
          label: "QQ Bot",
          docsPath: "/channels/qqbot",
          approvalFlags: ["native"],
          doctorCapabilities: { openDmRequiresAllowFromWildcard: false },
        },
      },
    });
    useBundledPluginsDir(undefined);

    expect(findBundledChannelCatalogMetadata("qqbot")).toMatchObject({
      approvalFlags: ["native"],
      doctorCapabilities: { openDmRequiresAllowFromWildcard: false },
    });
  });

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

  it("keeps bundled package metadata when generated catalog entries are stale", () => {
    const root = seedRoot("bcr-package-wins-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    seedChannelPkg(path.join(extensionsRoot, "matrix", "package.json"), {
      id: "matrix",
      label: "Matrix",
      markdownCapable: true,
    });
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/matrix",
      id: "matrix",
      label: "Matrix",
      docsPath: "/channels/matrix",
      blurb: "stale generated entry",
    });
    useBundledPluginsDir(extensionsRoot);

    const matrix = listBundledChannelCatalogEntries().find((entry) => entry.id === "matrix");
    expect(matrix?.channel.markdownCapable).toBe(true);
  });

  it("falls back to dist/channel-catalog.json when the resolved dir has no plugin package.jsons", () => {
    // An empty override directory must not hide the shipped catalog.
    const root = seedRoot("bcr-fallback-empty-");
    const extensionsRoot = path.join(root, "dist", "extensions");
    fs.mkdirSync(extensionsRoot, { recursive: true });
    seedGeneratedChannelCatalog(root, {
      packageName: "@openclaw/fallback",
      id: "fallback-channel",
      label: "Fallback",
      docsPath: "/channels/fallback",
      blurb: "fallback blurb",
    });
    useBundledPluginsDir(extensionsRoot);

    const entries = listBundledChannelCatalogEntries();
    expect(entries.map((entry) => entry.id)).toContain("fallback-channel");
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
