import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginCandidate } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function candidate(
  origin: PluginCandidate["origin"],
  manifest: Record<string, unknown>,
  id = "external-chat",
): PluginCandidate {
  const rootDir = tempDirs.make("openclaw-manifest-diagnostics-");
  mkdirSafeDir(rootDir);
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id, configSchema: { type: "object" }, ...manifest }),
    "utf-8",
  );
  return { idHint: id, rootDir, origin, source: path.join(rootDir, "index.ts") };
}

function expectNoRegistryDiagnosticContains(
  registry: ReturnType<typeof loadPluginManifestRegistryCore>,
  fragment: string,
) {
  expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(fragment);
}

describe("loadPluginManifestRegistry compatibility diagnostics", () => {
  it("reports only selected plugin compatibility diagnostics", () => {
    const manifest = { channels: ["external-chat"] };
    const global = candidate("global", { ...manifest, uiCapabilities: "page" });
    const config = candidate("config", {
      ...manifest,
      uiCapabilities: [],
      channelConfigs: { "external-chat": { schema: { type: "object" } } },
    });

    const registry = loadPluginManifestRegistryCore({
      candidates: [global, config],
      diagnostics: [global.rootDir, config.rootDir, global.rootDir].map((source) => ({
        level: "warn" as const,
        pluginId: "external-chat",
        source,
        message: "extension entry unreadable (I/O error): ./index.js",
      })),
    });

    expect(registry.plugins.map((plugin) => plugin.rootDir)).toEqual([config.rootDir]);
    expectNoRegistryDiagnosticContains(registry, "invalid plugin manifest uiCapabilities");
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({ level: "info", code: "explicit-config-plugin-selection" }),
    );
    const sources = (fragment: string) =>
      registry.diagnostics
        .filter((diagnostic) => diagnostic.message.includes(fragment))
        .map((diagnostic) => diagnostic.source);
    expect(sources("extension entry unreadable")).toEqual([global.rootDir, config.rootDir]);
    expect(sources("without channelConfigs metadata")).toEqual([]);
  });

  it("suppresses missing channel config diagnostics for inactive external channel plugins", () => {
    const inactive = candidate("global", { channels: ["external-chat"] });

    for (const plugins of [
      { entries: { "external-chat": { enabled: false } } },
      { allow: ["other-plugin"] },
    ]) {
      const registry = loadPluginManifestRegistryCore({
        config: { plugins },
        candidates: [inactive],
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
      "http://example.com/icon.svg",
      "javascript:alert(1)",
      `https://example.com/${"a".repeat(2048)}`,
    ].map((url, index) =>
      Object.assign(authChoice(`unsafe-${index}`), { icon: url, website: url, docsUrl: url }),
    ),
    expected: [authChoice("unsafe-0"), authChoice("unsafe-1"), authChoice("unsafe-2")],
  },
  ...[["not-a-platform"], "darwin"].map((platforms) => ({
    name: `preserves unavailable platform restriction ${JSON.stringify(platforms)}`,
    choices: [{ ...authChoice("native", "local"), platforms }],
    expected: [{ ...authChoice("native", "local"), platforms: [] }],
  })),
])("$name", ({ choices, expected }) => {
  const registry = loadPluginManifestRegistryCore({
    candidates: [candidate("bundled", { providerAuthChoices: choices }, "auth")],
  });
  expect(registry.plugins[0]?.providerAuthChoices).toEqual(expected);
});
