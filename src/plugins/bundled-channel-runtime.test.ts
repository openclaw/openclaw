import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));

import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  resolveBundledChannelWorkspacePath,
} from "./bundled-channel-runtime.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-empty-bundled-root-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function createRegistry(plugins: PluginManifestRegistry["plugins"]): PluginManifestRegistry {
  return { plugins, diagnostics: [] };
}

function createPluginRecord(
  overrides: Pick<PluginManifestRecord, "id" | "origin"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    rootDir: `/tmp/${overrides.id}`,
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    name: undefined,
    description: undefined,
    version: undefined,
    enabledByDefault: undefined,
    autoEnableWhenConfiguredProviders: undefined,
    legacyPluginIds: undefined,
    format: undefined,
    bundleFormat: undefined,
    bundleCapabilities: undefined,
    kind: undefined,
    channels: [],
    providers: [],
    modelSupport: undefined,
    cliBackends: [],
    channelEnvVars: undefined,
    providerAuthAliases: undefined,
    providerAuthChoices: undefined,
    skills: [],
    settingsFiles: undefined,
    hooks: [],
    source: `/tmp/${overrides.id}/channel.js`,
    setupSource: undefined,
    startupDeferConfiguredChannelFullLoadUntilAfterListen: undefined,
    channelCatalogMeta: undefined,
    ...overrides,
  };
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("bundled channel runtime metadata", () => {
  beforeEach(() => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(createRegistry([]));
  });

  it("preserves explicit empty bundled roots", () => {
    const tempRoot = createTempRoot();

    expect(listBundledChannelPluginMetadata({ rootDir: tempRoot })).toStrictEqual([]);
    expect(resolveBundledChannelWorkspacePath({ rootDir: tempRoot, pluginId: "telegram" })).toBe(
      null,
    );
  });

  it("preserves explicit missing bundled scan roots", () => {
    const tempRoot = createTempRoot();
    const missingScanDir = path.join(tempRoot, "missing-extensions");

    expect(
      listBundledChannelPluginMetadata({ rootDir: tempRoot, scanDir: missingScanDir }),
    ).toStrictEqual([]);
  });

  it("prefers package-local dist entries over source checkout channel entries", () => {
    const tempRoot = createTempRoot();
    const pluginRoot = path.join(tempRoot, "extensions", "slack");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        tempRoot,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "slack",
        path.join(tempRoot, "extensions"),
      ),
    ).toBe(path.join(pluginRoot, "dist", "index.js"));
  });

  it("prefers package-local dist entries for absolute installed registry sources", () => {
    const tempRoot = createTempRoot();
    const pluginRoot = path.join(tempRoot, "extensions", "slack");
    const builtScanRoot = path.join(tempRoot, "dist", "extensions");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(builtScanRoot, "slack"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        tempRoot,
        {
          source: path.join(pluginRoot, "index.ts"),
          built: path.join(pluginRoot, "index.ts"),
        },
        "slack",
        builtScanRoot,
      ),
    ).toBe(path.join(pluginRoot, "dist", "index.js"));
  });

  it("skips unreadable bundled channel rows without dropping healthy rows", () => {
    const unreadable = createPluginRecord({
      id: "broken-channel",
      origin: "bundled",
      channels: ["broken-channel"],
    });
    Object.defineProperty(unreadable, "rootDir", {
      get() {
        throw new Error("bundled channel root metadata exploded");
      },
    });

    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(
      createRegistry([
        unreadable,
        createPluginRecord({
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          rootDir: "/tmp/extensions/slack",
          source: "/tmp/extensions/slack/channel.js",
          setupSource: "/tmp/extensions/slack/setup.js",
        }),
      ]),
    );

    expect(listBundledChannelPluginMetadata()).toStrictEqual([
      {
        dirName: "slack",
        source: {
          source: "/tmp/extensions/slack/channel.js",
          built: "/tmp/extensions/slack/channel.js",
        },
        setupSource: {
          source: "/tmp/extensions/slack/setup.js",
          built: "/tmp/extensions/slack/setup.js",
        },
        manifest: {
          id: "slack",
          channels: ["slack"],
        },
        rootDir: "/tmp/extensions/slack",
      },
    ]);
  });
});
