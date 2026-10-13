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
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
}

function createPluginCandidate(
  params: Pick<PluginCandidate, "idHint" | "rootDir" | "origin">,
): PluginCandidate {
  return { ...params, source: path.join(params.rootDir, "index.ts") };
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
    const manifest = {
      id: "external-chat",
      channels: ["external-chat"],
      configSchema: { type: "object" },
    };
    writeManifest(globalDir, { ...manifest, uiCapabilities: "page" });
    writeManifest(configDir, {
      ...manifest,
      uiCapabilities: [],
      channelConfigs: { "external-chat": { schema: { type: "object" } } },
    });

    const registry = loadPluginManifestRegistryCore({
      candidates: [
        createPluginCandidate({
          idHint: "external-chat",
          rootDir: globalDir,
          origin: "global",
        }),
        createPluginCandidate({
          idHint: "external-chat",
          rootDir: configDir,
          origin: "config",
        }),
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
      configSchema: { type: "object" },
    });
    const candidate = createPluginCandidate({
      idHint: "external-chat",
      rootDir: dir,
      origin: "global",
    });

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

it.each([
  {
    name: "drops non-HTTPS provider auth presentation URLs",
    manifest: {
      id: "unsafe-auth-artwork",
      providerAuthChoices: [
        {
          provider: "unsafe",
          method: "api-key",
          choiceId: "unsafe-api-key",
          icon: "http://example.com/icon.svg",
          website: "javascript:alert(1)",
          docsUrl: "javascript:alert(1)",
        },
        {
          provider: "oversized",
          method: "api-key",
          choiceId: "oversized-api-key",
          icon: `https://example.com/${"a".repeat(2048)}`,
          docsUrl: `https://example.com/${"a".repeat(2048)}`,
        },
      ],
      configSchema: { type: "object" },
    },
    expected: {
      providerAuthChoices: [
        {
          provider: "unsafe",
          method: "api-key",
          choiceId: "unsafe-api-key",
        },
        {
          provider: "oversized",
          method: "api-key",
          choiceId: "oversized-api-key",
        },
      ],
    },
  },
  ...[["not-a-platform"], "darwin"].map((platforms) => ({
    name: `preserves unavailable platform restriction ${JSON.stringify(platforms)}`,
    manifest: {
      id: "native-provider",
      configSchema: { type: "object" },
      providerAuthChoices: [
        { provider: "native", method: "local", choiceId: "native-local", platforms },
      ],
    },
    expected: {
      providerAuthChoices: [
        { provider: "native", method: "local", choiceId: "native-local", platforms: [] },
      ],
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
