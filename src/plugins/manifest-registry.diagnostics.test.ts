import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginCandidate } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeTempDir() {
  const dir = tempDirs.make("openclaw-manifest-diagnostics-");
  mkdirSafeDir(dir);
  return dir;
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ configSchema: { type: "object" }, ...manifest }),
    "utf-8",
  );
}

function createPluginCandidate(
  rootDir: string,
  origin: PluginCandidate["origin"],
): PluginCandidate {
  return { idHint: "external-chat", rootDir, origin, source: path.join(rootDir, "index.ts") };
}

function expectNoRegistryDiagnosticContains(
  registry: ReturnType<typeof loadPluginManifestRegistryCore>,
  fragment: string,
) {
  expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(fragment);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadPluginManifestRegistry compatibility diagnostics", () => {
  it("reports only selected plugin compatibility diagnostics", () => {
    const globalDir = makeTempDir();
    const configDir = makeTempDir();
    const manifest = { id: "external-chat", channels: ["external-chat"] };
    writeManifest(globalDir, { ...manifest, uiCapabilities: "page" });
    writeManifest(configDir, {
      ...manifest,
      uiCapabilities: [],
      channelConfigs: { "external-chat": { schema: { type: "object" } } },
    });

    const registry = loadPluginManifestRegistryCore({
      candidates: [
        createPluginCandidate(globalDir, "global"),
        createPluginCandidate(configDir, "config"),
      ],
      diagnostics: [globalDir, configDir, globalDir].map((source) => ({
        level: "warn" as const,
        pluginId: "external-chat",
        source,
        message: "extension entry unreadable (I/O error): ./index.js",
      })),
    });

    expect(registry.plugins.map((plugin) => plugin.rootDir)).toEqual([configDir]);
    expectNoRegistryDiagnosticContains(registry, "invalid plugin manifest uiCapabilities");
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({ level: "info", code: "explicit-config-plugin-selection" }),
    );
    expect(
      registry.diagnostics
        .filter((diagnostic) => diagnostic.message.includes("extension entry unreadable"))
        .map((diagnostic) => diagnostic.source),
    ).toEqual([globalDir, configDir]);
    expect(
      registry.diagnostics
        .filter((diagnostic) => diagnostic.message.includes("without channelConfigs metadata"))
        .map((diagnostic) => diagnostic.source),
    ).toEqual([]);
  });

  it("suppresses missing channel config diagnostics for inactive external channel plugins", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "external-chat",
      channels: ["external-chat"],
    });
    const candidate = createPluginCandidate(dir, "global");

    const disabledRegistry = loadPluginManifestRegistryCore({
      config: { plugins: { entries: { "external-chat": { enabled: false } } } },
      candidates: [candidate],
    });
    expectNoRegistryDiagnosticContains(disabledRegistry, "without channelConfigs metadata");

    const allowlistRegistry = loadPluginManifestRegistryCore({
      config: { plugins: { allow: ["other-plugin"] } },
      candidates: [candidate],
    });
    expectNoRegistryDiagnosticContains(allowlistRegistry, "without channelConfigs metadata");
  });
});

const authChoice = (provider: string, method = "api-key") => ({
  provider,
  method,
  choiceId: `${provider}-${method}`,
});

it.each([
  {
    name: "drops non-HTTPS provider auth presentation URLs",
    manifest: {
      id: "unsafe-auth-artwork",
      providerAuthChoices: [
        {
          ...authChoice("unsafe"),
          icon: "http://example.com/icon.svg",
          website: "javascript:alert(1)",
          docsUrl: "javascript:alert(1)",
        },
        {
          ...authChoice("oversized"),
          icon: `https://example.com/${"a".repeat(2048)}`,
          docsUrl: `https://example.com/${"a".repeat(2048)}`,
        },
      ],
    },
    expected: {
      providerAuthChoices: [authChoice("unsafe"), authChoice("oversized")],
    },
  },
  ...[["not-a-platform"], "darwin"].map((platforms) => ({
    name: `preserves unavailable platform restriction ${JSON.stringify(platforms)}`,
    manifest: {
      id: "native-provider",
      providerAuthChoices: [{ ...authChoice("native", "local"), platforms }],
    },
    expected: {
      providerAuthChoices: [{ ...authChoice("native", "local"), platforms: [] }],
    },
  })),
])("$name", ({ manifest, expected }) => {
  const rootDir = makeTempDir();
  writeManifest(rootDir, manifest);
  const registry = loadPluginManifestRegistryCore({
    candidates: [
      { idHint: manifest.id, rootDir, origin: "bundled", source: path.join(rootDir, "index.ts") },
    ],
  });
  const plugin = registry.plugins[0];
  expect(plugin).toBeDefined();
  for (const [key, value] of Object.entries(expected)) {
    expect(plugin && Reflect.get(plugin, key), key).toEqual(value);
  }
});
