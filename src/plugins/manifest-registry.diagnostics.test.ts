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
  it.each([false, true])(
    "reports only selected plugin compatibility diagnostics (channel configs: %s)",
    (hasChannelConfigs) => {
      const globalDir = makeTempDir();
      const configDir = makeTempDir();
      const manifest = {
        id: "external-chat",
        channels: ["external-chat"],
        configSchema: { type: "object" },
      };
      writeManifest(globalDir, manifest);
      writeManifest(configDir, {
        ...manifest,
        ...(hasChannelConfigs
          ? { channelConfigs: { "external-chat": { schema: { type: "object" } } } }
          : {}),
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
      expect(
        registry.diagnostics
          .filter((diagnostic) => diagnostic.message.includes("extension entry unreadable"))
          .map((diagnostic) => diagnostic.source),
      ).toEqual([globalDir, configDir]);
      expect(
        registry.diagnostics
          .filter((diagnostic) => diagnostic.message.includes("without channelConfigs metadata"))
          .map((diagnostic) => diagnostic.source),
      ).toEqual(hasChannelConfigs ? [] : [path.join(configDir, "openclaw.plugin.json")]);
    },
  );

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
