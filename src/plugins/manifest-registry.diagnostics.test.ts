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
    const sources = (fragment: string) =>
      registry.diagnostics
        .filter((diagnostic) => diagnostic.message.includes(fragment))
        .map((diagnostic) => diagnostic.source);
    expect(sources("extension entry unreadable")).toEqual([globalDir, configDir]);
    expect(sources("without channelConfigs metadata")).toEqual([]);
  });

  it("suppresses missing channel config diagnostics for inactive external channel plugins", () => {
    const dir = makeTempDir();
    writeManifest(dir, { id: "external-chat", channels: ["external-chat"] });
    const candidate = createPluginCandidate(dir, "global");

    for (const plugins of [
      { entries: { "external-chat": { enabled: false } } },
      { allow: ["other-plugin"] },
    ]) {
      const registry = loadPluginManifestRegistryCore({
        config: { plugins },
        candidates: [candidate],
      });
      expectNoRegistryDiagnosticContains(registry, "without channelConfigs metadata");
    }
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
    choices: [
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
    expected: [authChoice("unsafe"), authChoice("oversized")],
  },
  ...[["not-a-platform"], "darwin"].map((platforms) => ({
    name: `preserves unavailable platform restriction ${JSON.stringify(platforms)}`,
    choices: [{ ...authChoice("native", "local"), platforms }],
    expected: [{ ...authChoice("native", "local"), platforms: [] }],
  })),
])("$name", ({ choices, expected }) => {
  const rootDir = makeTempDir();
  writeManifest(rootDir, { id: "auth", providerAuthChoices: choices });
  const registry = loadPluginManifestRegistryCore({
    candidates: [
      { idHint: "auth", rootDir, origin: "bundled", source: path.join(rootDir, "index.ts") },
    ],
  });
  expect(registry.plugins[0]?.providerAuthChoices).toEqual(expected);
});
