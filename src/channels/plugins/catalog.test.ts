// Channel plugin catalog tests cover plugin catalog entries and metadata normalization.
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
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      entries: [
        {
          name: `@example/${id}`,
          openclaw: {
            channel: { id, label, selectionLabel: label, docsPath: `/channels/${id}`, blurb: id },
            install: { npmSpec: `@example/${id}`, ...(defaultChoice ? { defaultChoice } : {}) },
          },
        },
      ],
    }),
  );
}

describe("channel plugin catalog", () => {
  it("keeps catalog-only channel IDs in the selected metadata owner", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-ids-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const catalogPath = path.join(root, "dist", "channel-catalog.json");
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

  it.each(["present", "missing"] as const)(
    "shares %s generated catalog facts across consumers until the owner changes",
    (initialState) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shared-channel-catalog-"));
      tempDirs.push(root);
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      vi.spyOn(process, "cwd").mockReturnValue(root);
      const catalogPath = path.join(root, "dist", "channel-catalog.json");
      const options = { catalogPaths: [path.join(root, "external.json")], env: {} };
      if (initialState === "present") {
        writeChannelCatalog(catalogPath, "shared-catalog", "Original catalog");
      }
      const originalLabel = initialState === "present" ? "Original catalog" : undefined;
      expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBe(
        originalLabel,
      );

      writeChannelCatalog(catalogPath, "shared-catalog", "Updated catalog");
      expect(findBundledChannelCatalogMetadata("shared-catalog")?.label).toBe(originalLabel);
      expect(
        withPluginCache(
          createPluginCache(),
          () => getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label,
        ),
      ).toBe("Updated catalog");
      expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBe(
        originalLabel,
      );

      clearPluginMetadataLifecycleCaches();
      expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBe(
        "Updated catalog",
      );
      expect(findBundledChannelCatalogMetadata("shared-catalog")?.label).toBe("Updated catalog");
    },
  );

  it.each([
    ["omitted", undefined, undefined],
    ["empty", "", ""],
    ["spaced", "  See docs:  ", "  See docs:  "],
  ] as const)("preserves %s selection docs prefixes", (_label, prefix, expected) => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "workspace-chat",
        origin: "workspace",
        rootDir: "/tmp/workspace-chat",
        packageName: "@workspace/chat",
        channel: {
          id: "custom-chat",
          label: "Custom Chat",
          selectionLabel: "Custom Chat",
          docsPath: "/channels/custom-chat",
          blurb: "workspace",
          ...(prefix !== undefined ? { selectionDocsPrefix: prefix } : {}),
        },
        install: { localPath: "/tmp/workspace-chat" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    const entry = getChannelPluginCatalogEntry("custom-chat", {
      workspaceDir: "/tmp",
    });

    expect(entry?.meta.selectionDocsPrefix).toBe(expected);
  });

  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };

    const wecom = getChannelPluginCatalogEntry("wecom", options);
    expect(wecom?.id).toBe("wecom");
    expect(wecom?.pluginId).toBe("wecom-openclaw-plugin");
    expect(wecom?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(wecom?.install?.npmSpec).toBe("@wecom/wecom-openclaw-plugin@2026.7.2");

    const yuanbao = getChannelPluginCatalogEntry("yuanbao", options);
    expect(yuanbao?.id).toBe("yuanbao");
    expect(yuanbao?.pluginId).toBe("openclaw-plugin-yuanbao");
    expect(yuanbao?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(yuanbao?.install?.npmSpec).toBe("openclaw-plugin-yuanbao@2.18.2");
  });

  it("excludes only the rejected origin/plugin pair when resolving fallback copies", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "telegram",
        origin: "config",
        rootDir: "/tmp/config-telegram",
        packageName: "telegram-shadow",
        channel: {
          id: "telegram",
          label: "Telegram Shadow",
          selectionLabel: "Telegram Shadow",
          docsPath: "/channels/telegram",
          blurb: "shadow",
        },
        install: { localPath: "/tmp/config-telegram" },
      },
      {
        pluginId: "telegram",
        origin: "bundled",
        rootDir: "/tmp/bundled-telegram",
        packageName: "@openclaw/telegram",
        channel: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "bundled",
        },
        install: { npmSpec: "@openclaw/telegram@1.0.0" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    expect(
      getChannelPluginCatalogEntry("telegram", {
        excludePluginRefs: [{ pluginId: "telegram", origin: "config" }],
      })?.origin,
    ).toBe("bundled");
  });

  it.each(["__proto__", "constructor", "toString"])(
    "rejects inherited install default choice %s from external catalog input",
    (defaultChoice) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-choice-"));
      tempDirs.push(root);
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

  it("reloads external catalog entries after the explicit plugin metadata lifecycle reset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-external-catalog-"));
    tempDirs.push(root);
    const catalogPath = path.join(root, "catalog.json");
    const options = { catalogPaths: [catalogPath], workspaceDir: root, env: {} };

    expect(getChannelPluginCatalogEntry("lifecycle-external", options)).toBeUndefined();
    writeChannelCatalog(catalogPath, "lifecycle-external", "After external install");
    clearPluginMetadataLifecycleCaches();

    expect(getChannelPluginCatalogEntry("lifecycle-external", options)?.meta.label).toBe(
      "After external install",
    );
  });

  it("reloads official generated catalog entries after the explicit plugin metadata lifecycle reset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-official-catalog-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const catalogPath = path.join(root, "dist", "channel-catalog.json");
    const options = { catalogPaths: [path.join(root, "external.json")], env: {} };

    expect(getChannelPluginCatalogEntry("lifecycle-official", options)).toBeUndefined();
    writeChannelCatalog(catalogPath, "lifecycle-official", "After official update");
    clearPluginMetadataLifecycleCaches();

    expect(getChannelPluginCatalogEntry("lifecycle-official", options)?.meta.label).toBe(
      "After official update",
    );
  });
  it.each([
    { name: "bundled", origin: "bundled", trusted: false, expected: "/channels/fixture" },
    { name: "official npm global", origin: "global", trusted: true, expected: "/channels/fixture" },
    { name: "official config", origin: "config", trusted: true, expected: "/channels/fixture" },
    { name: "untracked official identity", origin: "global", trusted: false },
    { name: "workspace shadow", origin: "workspace", trusted: true },
    {
      name: "third-party package shadow",
      origin: "global",
      trusted: true,
      packageName: "@vendor/fixture",
    },
    { name: "different plugin owner", origin: "global", trusted: true, pluginId: "other-owner" },
  ] as const)("binds docs to official metadata for $name", (scenario) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-docs-")));
    tempDirs.push(root);
    const officialPath = path.join(root, "official.json");
    writeChannelCatalog(officialPath, "fixture", "Fixture");
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: ("pluginId" in scenario ? scenario.pluginId : undefined) ?? "fixture",
        origin: scenario.origin,
        rootDir: root,
        packageName: "packageName" in scenario ? scenario.packageName : "@example/fixture",
        trustedOfficialInstall: scenario.trusted,
        channel: {
          id: "fixture",
          label: "Installed Fixture",
          docsPath:
            scenario.origin === "bundled" ? "/channels/fixture" : "/unverified-installed-guide",
          blurb: "fixture",
        },
        install: { npmSpec: "@example/fixture" },
      },
    ]);
    const entry = getChannelPluginCatalogEntry("fixture", {
      officialCatalogPaths: [officialPath],
      catalogPaths: [path.join(root, "none.json")],
      env: {},
    });
    expect(entry?.officialDocsPath).toBe("expected" in scenario ? scenario.expected : undefined);
    expect(entry?.trustedSourceLinkedOfficialInstall).toBeUndefined();
  });

  it.each([
    "https://attacker.example/setup",
    "//attacker.example/setup",
    "/x/..//attacker.example/setup",
    "/\\attacker.example/setup",
    "relative/path",
  ])("omits unsafe official docs path %s", (docsPath) => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "fixture",
        origin: "bundled",
        rootDir: "/tmp/fixture",
        packageName: "@example/fixture",
        channel: { id: "fixture", label: "Fixture", docsPath, blurb: "fixture" },
        install: { npmSpec: "@example/fixture" },
      },
    ]);
    expect(getChannelPluginCatalogEntry("fixture", { env: {} })?.officialDocsPath).toBeUndefined();
  });
});
