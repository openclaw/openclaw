import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile as writeJson } from "../../test/helpers/temp-repo.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import { listChannelCatalogEntries } from "./channel-catalog-registry.js";
import { resolvePluginConfigContractsById } from "./config-contracts.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { makePluginMetadataIndex } from "./current-plugin-metadata.test-support.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  completePluginMetadataSnapshot,
  loadPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { writeArtifacts as writeFiles } from "./public-surface.test-support.js";

const { manifestScanWarn } = vi.hoisted(() => ({
  manifestScanWarn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "plugins/manifest-metadata-scan"
        ? { ...logger, warn: manifestScanWarn }
        : logger;
    },
  };
});

const tempRoots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    cleanup();
  }),
);

function createPluginFixture(pluginName: string, contents?: string | object, bundled?: string) {
  const root = tempRoots.make("openclaw-manifest-metadata-");
  const home = path.join(root, "home");
  const bundledRoot = path.join(root, bundled ?? "empty-bundled");
  const pluginDir = path.join(
    bundled ? bundledRoot : path.join(home, ".openclaw", "extensions"),
    pluginName,
  );
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  fs.mkdirSync(pluginDir, { recursive: true });
  if (contents !== undefined) {
    writeFiles(pluginDir, { "openclaw.plugin.json": contents });
  }
  return {
    root,
    home,
    bundledRoot,
    pluginDir,
    manifestPath,
    env: {
      OPENCLAW_HOME: home,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    },
  };
}

function scanPlugin(env: NodeJS.ProcessEnv, id: string) {
  return listOpenClawPluginManifestMetadata(env).find((record) => record.manifest.id === id);
}

function warningMessagesForPath(manifestPath: string): string[] {
  return manifestScanWarn.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes(manifestPath));
}

describe("listOpenClawPluginManifestMetadata", () => {
  beforeEach(() => {
    manifestScanWarn.mockClear();
  });

  it.each(["manifest", "channel", "source", "contract"] as const)(
    "keeps %s readers on startup metadata after package files change",
    (reader) => {
      const { bundledRoot, pluginDir, env } = createPluginFixture(
        "startup-owner",
        undefined,
        "bundled",
      );
      const writePackage = (generation: string, pluginId = "startup-owner") => {
        const targetDir = path.join(bundledRoot, pluginId);
        writeFiles(targetDir, {
          "package.json": {
            name: `@fixture/${pluginId}`,
            version: generation,
            openclaw: {
              extensions: ["./index.cjs"],
              channel: { id: "startup-channel", label: generation },
            },
          },
          "openclaw.plugin.json": {
            id: pluginId,
            version: generation,
            configSchema: { type: "object" },
            configContracts: {
              secretInputs: { paths: [{ path: generation, expected: "string" }] },
            },
          },
          "index.cjs": 'throw new Error("runtime imported");',
        });
      };
      writePackage("1.0.0");
      const config = {};
      const snapshot = completePluginMetadataSnapshot({
        snapshot: loadPluginMetadataSnapshot({ config, env, preferPersisted: false }),
        config,
        env,
      });
      assert(snapshot);
      expect(snapshot.byPluginId.get("startup-owner")?.version).toBe("1.0.0");
      setGatewayPluginMetadataSnapshot(snapshot, { config, env });
      writePackage("2.0.0");
      writePackage("2.0.0", "added-after-startup");

      const readdirSpy = vi.spyOn(fs, "readdirSync");
      const readFileSpy = vi.spyOn(fs, "readFileSync");
      const readers = {
        manifest: (id: string) => scanPlugin(env, id)?.manifest.version,
        channel: (id: string) =>
          listChannelCatalogEntries({ env }).find((entry) => entry.pluginId === id)?.channel.label,
        source: (id: string) => resolveBundledPluginSources({ env }).get(id)?.version,
        contract: (id: string) =>
          resolvePluginConfigContractsById({
            env,
            pluginIds: [id],
            fallbackToBundledMetadataForResolvedBundled: true,
          }).get(id)?.configContracts.secretInputs?.paths[0]?.path,
      };
      const readGeneration = (id = "startup-owner") => readers[reader](id);
      expect(readGeneration()).toBe("1.0.0");
      expect(readGeneration()).toBe("1.0.0");
      expect(readGeneration("added-after-startup")).toBeUndefined();
      expect(readdirSpy).not.toHaveBeenCalled();
      expect(readFileSpy.mock.calls.filter(([file]) => String(file).startsWith(pluginDir))).toEqual(
        [],
      );
    },
  );

  it("prefers the active bundled manifest over stale persisted bundled installs", async () => {
    const { root, home, bundledRoot, env } = createPluginFixture("openai", undefined, "extensions");
    const staleBundledRoot = path.join(root, "stale", "extensions");

    writeJson(path.join(bundledRoot, "openai", "openclaw.plugin.json"), {
      id: "openai",
      providerEndpoints: [{ endpointClass: "openai-public", hosts: ["api.openai.com"] }],
    });
    writeJson(path.join(staleBundledRoot, "openai", "openclaw.plugin.json"), {
      id: "openai",
      providers: ["openai"],
    });
    const index = makePluginMetadataIndex("openai");
    Object.assign(index.plugins[0]!, {
      manifestPath: path.join(staleBundledRoot, "openai", "openclaw.plugin.json"),
      manifestHash: "stale-openai",
      rootDir: path.join(staleBundledRoot, "openai"),
      origin: "bundled",
    });
    await writePersistedInstalledPluginIndex(index, { stateDir: path.join(home, ".openclaw") });

    const openai = scanPlugin(env, "openai");
    expect(openai?.pluginDir).toBe(path.join(bundledRoot, "openai"));
    expect(openai?.manifest.providerEndpoints).toEqual([
      { endpointClass: "openai-public", hosts: ["api.openai.com"] },
    ]);
  });

  it("keeps source manifest metadata when the active bundled tree is partial", () => {
    const { env } = createPluginFixture(
      "qa-lab",
      {
        id: "qa-lab",
        providers: ["qa-lab"],
      },
      path.join("dist", "extensions"),
    );
    const openai = scanPlugin(env, "openai");
    expect(openai?.origin).toBe("source");
    expect(openai?.pluginDir).toBe(path.join(process.cwd(), "extensions", "openai"));
    expect(openai?.manifest.providerEndpoints).toContainEqual({
      endpointClass: "openai-public",
      hosts: ["api.openai.com"],
      hostSuffixes: [".api.openai.com"],
    });
  });

  it.each([0, 1])("enforces the manifest byte limit (overflow: %s)", (overflow) => {
    const bytes = 256 * 1024 + overflow;
    const manifest = { id: "bounded-plugin", pad: "" };
    manifest.pad = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(manifest), "utf8"));
    const { pluginDir, manifestPath, env } = createPluginFixture(manifest.id, manifest);
    const goodPluginDir = path.join(path.dirname(pluginDir), "good-plugin");
    writeJson(path.join(goodPluginDir, "openclaw.plugin.json"), { id: "good-plugin" });
    expect(fs.statSync(manifestPath).size).toBe(bytes);
    const records = listOpenClawPluginManifestMetadata(env);
    expect(records.find((record) => record.manifest.id === "good-plugin")).toBeTruthy();
    expect(records.some((record) => record.manifest.id === manifest.id)).toBe(!overflow);
    expect(listOpenClawPluginManifestMetadata(env)).toEqual(records);
    expect(warningMessagesForPath(manifestPath)).toEqual(
      overflow
        ? [
            `Ignoring oversized plugin manifest at ${manifestPath}: file exceeds the 262144-byte limit`,
          ]
        : [],
    );
  });

  it.each([
    [
      "malformed JSON/JSON5",
      "{invalid",
      "invalid",
      "failed to parse plugin manifest: JSON5: invalid end of input at 1:9",
    ],
    ["non-object JSON", "[]", "invalid", "plugin manifest must be an object"],
    ["non-regular file", undefined, "unreadable", "path does not have the required file type"],
    ["missing file", undefined, undefined, undefined],
    ["JSON5", "{ id: 'invalid-plugin', }", undefined, undefined],
  ])("handles %s with at most one warning across cache hits", (name, contents, kind, error) => {
    const { pluginDir, manifestPath, env } = createPluginFixture("invalid-plugin", contents);
    if (name === "non-regular file") {
      fs.mkdirSync(manifestPath);
    }
    for (let scan = 0; scan < 2; scan++) {
      const record = listOpenClawPluginManifestMetadata(env).find(
        (entry) => entry.pluginDir === pluginDir,
      );
      expect(record).toEqual(
        name === "JSON5"
          ? { pluginDir, manifest: { id: "invalid-plugin" }, origin: "global" }
          : undefined,
      );
    }
    expect(warningMessagesForPath(manifestPath)).toEqual(
      kind ? [`Ignoring ${kind} plugin manifest at ${manifestPath}: ${error}`] : [],
    );
  });
});
