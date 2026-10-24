import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { findBundledChannelCatalogMetadata } from "../bundled-channel-catalog-read.js";
import { normalizeChatChannelId } from "../ids.js";

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => []),
);

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/bundled-dir.js")>()),
  resolveBundledPluginsDir: () => undefined,
}));

import { getChannelPluginCatalogEntry } from "./catalog.js";

const tempDirs: string[] = [];

function makeRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-")));
  tempDirs.push(root);
  return root;
}

function catalogEntry(
  fields: Omit<Partial<PluginChannelCatalogEntry>, "channel"> = {},
  channel: Partial<PluginChannelCatalogEntry["channel"]> = {},
): PluginChannelCatalogEntry {
  return {
    pluginId: "fixture",
    origin: "bundled",
    rootDir: "/tmp/fixture",
    packageName: "@example/fixture",
    install: { npmSpec: "@example/fixture" },
    ...fields,
    channel: {
      id: "fixture",
      label: "Fixture",
      docsPath: "/channels/fixture",
      blurb: "fixture",
      ...channel,
    },
  };
}

function generatedCatalog() {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return { root, catalogPath: path.join(root, "dist", "channel-catalog.json") };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  listChannelCatalogEntriesMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeChannelCatalog(
  catalogPath: string,
  id: string,
  label: string,
  defaultChoice?: string,
): void {
  const channel = { id, label, selectionLabel: label, docsPath: `/channels/${id}`, blurb: id };
  const install = { npmSpec: `@example/${id}`, ...(defaultChoice ? { defaultChoice } : {}) };
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      entries: [{ name: `@example/${id}`, openclaw: { channel, install } }],
    }),
  );
}

describe("channel plugin catalog", () => {
  it("keeps catalog-only channel IDs in the selected metadata owner", () => {
    const { catalogPath } = generatedCatalog();
    writeChannelCatalog(catalogPath, "catalog-original", "Original catalog");
    expect(normalizeChatChannelId("catalog-original")).toBe("catalog-original");

    writeChannelCatalog(catalogPath, "catalog-updated", "Updated catalog");
    expect(
      withPluginCache(createPluginCache(), () => normalizeChatChannelId("catalog-updated")),
    ).toBe("catalog-updated");
    expect(normalizeChatChannelId("catalog-original")).toBe("catalog-original");
    expect(normalizeChatChannelId("catalog-updated")).toBeNull();

    clearPluginMetadataLifecycleCaches();
    expect(normalizeChatChannelId("catalog-updated")).toBe("catalog-updated");
    expect(normalizeChatChannelId("catalog-original")).toBeNull();
  });

  it("shares missing generated catalog facts across consumers until the owner changes", () => {
    const { root, catalogPath } = generatedCatalog();
    const options = { catalogPaths: [path.join(root, "external.json")], env: {} };
    expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBeUndefined();

    writeChannelCatalog(catalogPath, "shared-catalog", "Updated catalog");
    expect(findBundledChannelCatalogMetadata("shared-catalog")?.label).toBeUndefined();
    expect(
      withPluginCache(
        createPluginCache(),
        () => getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label,
      ),
    ).toBe("Updated catalog");
    expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBeUndefined();

    clearPluginMetadataLifecycleCaches();
    expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBe(
      "Updated catalog",
    );
    expect(findBundledChannelCatalogMetadata("shared-catalog")?.label).toBe("Updated catalog");
  });

  it("preserves spaced selection docs prefixes", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      catalogEntry(
        { origin: "workspace", install: { localPath: "/tmp/workspace-chat" } },
        { selectionDocsPrefix: "  See docs:  " },
      ),
    ]);
    expect(
      getChannelPluginCatalogEntry("fixture", { workspaceDir: "/tmp" })?.meta.selectionDocsPrefix,
    ).toBe("  See docs:  ");
  });

  it("excludes only the rejected origin/plugin pair when resolving fallback copies", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      catalogEntry({ origin: "config" }),
      catalogEntry({
        packageName: "@openclaw/telegram",
        install: { npmSpec: "@openclaw/telegram@1.0.0" },
      }),
    ]);

    expect(
      getChannelPluginCatalogEntry("fixture", {
        excludePluginRefs: [{ pluginId: "fixture", origin: "config" }],
      })?.origin,
    ).toBe("bundled");
  });

  it.each(["__proto__"])(
    "rejects inherited install default choice %s from external catalog input",
    (defaultChoice) => {
      const root = makeRoot();
      const catalogPath = path.join(root, "catalog.json");
      writeChannelCatalog(catalogPath, "unsafe-choice", "Unsafe Choice", defaultChoice);

      const entry = getChannelPluginCatalogEntry("unsafe-choice", {
        catalogPaths: [catalogPath],
        workspaceDir: root,
        env: {},
      });
      expect(entry?.install.defaultChoice).toBe("npm");
    },
  );

  it.each([
    ["bundled", "bundled", false, "@example/fixture", "fixture", "/channels/fixture"],
    ["official config", "config", true, "@example/fixture", "fixture", "/channels/fixture"],
    ["untracked official identity", "global", false, "@example/fixture", "fixture"],
    ["workspace shadow", "workspace", true, "@example/fixture", "fixture"],
    ["third-party package shadow", "global", true, "@vendor/fixture", "fixture"],
    ["different plugin owner", "global", true, "@example/fixture", "other-owner"],
  ] as const)(
    "binds docs to official metadata for %s",
    (_name, origin, trusted, packageName, pluginId, expected?: string) => {
      const root = makeRoot();
      const officialPath = path.join(root, "official.json");
      writeChannelCatalog(officialPath, "fixture", "Fixture");
      listChannelCatalogEntriesMock.mockReturnValue([
        catalogEntry(
          {
            pluginId,
            origin,
            rootDir: root,
            packageName,
            trustedOfficialInstall: trusted,
          },
          { docsPath: origin === "bundled" ? "/channels/fixture" : "/unverified-installed-guide" },
        ),
      ]);
      const entry = getChannelPluginCatalogEntry("fixture", {
        officialCatalogPaths: [officialPath],
        catalogPaths: [path.join(root, "none.json")],
        env: {},
      });
      expect(entry?.officialDocsPath).toBe(expected);
      expect(entry?.trustedSourceLinkedOfficialInstall).toBeUndefined();
    },
  );

  it.each([
    "https://attacker.example/setup",
    "//attacker.example/setup",
    "/x/..//attacker.example/setup",
    "/\\attacker.example/setup",
  ])("omits unsafe official docs path %s", (docsPath) => {
    listChannelCatalogEntriesMock.mockReturnValue([catalogEntry({}, { docsPath })]);
    expect(getChannelPluginCatalogEntry("fixture", { env: {} })?.officialDocsPath).toBeUndefined();
  });
});
