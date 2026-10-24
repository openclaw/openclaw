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
import { writeDoctorFiles as writeFiles } from "./doctor-contract.test-support.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  completePluginMetadataSnapshot,
  loadPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

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

function createPluginFixture(pluginName: string, contents?: unknown, bundled?: string) {
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

  it("keeps manifest metadata stable until explicit lifecycle invalidation", () => {
    const fixture = createPluginFixture("lifecycle-catalog", undefined, "extensions");
    const { manifestPath } = fixture;
    const env = { ...fixture.env, HOME: fixture.home };
    const writeManifest = (generation: string) =>
      writeJson(manifestPath, { id: "lifecycle-catalog", generation });

    writeManifest("first");
    clearPluginMetadataLifecycleCaches();
    const statSpy = vi.spyOn(fs, "statSync");
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    const first = scanPlugin(env, "lifecycle-catalog");
    expect(first?.manifest.generation).toBe("first");
    const firstStatCalls = statSpy.mock.calls.length;
    const firstReaddirCalls = readdirSpy.mock.calls.length;
    expect(firstReaddirCalls).toBeGreaterThan(0);
    const readFileSpy = vi.spyOn(fs, "readFileSync");
    const readBytesSpy = vi.spyOn(fs, "readSync");

    writeManifest("second");
    expect(scanPlugin(env, "lifecycle-catalog")?.manifest).toBe(first?.manifest);
    expect([readFileSpy.mock.calls, readBytesSpy.mock.calls]).toEqual([[], []]);
    expect(statSpy).toHaveBeenCalledTimes(firstStatCalls);
    expect(readdirSpy).toHaveBeenCalledTimes(firstReaddirCalls);

    clearPluginMetadataLifecycleCaches();
    expect(scanPlugin(env, "lifecycle-catalog")?.manifest.generation).toBe("second");
    expect(statSpy.mock.calls.length).toBeGreaterThan(firstStatCalls);
    expect(readdirSpy.mock.calls.length).toBeGreaterThan(firstReaddirCalls);
  });

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

  it("skips oversized plugin manifests to prevent OOM during metadata scan", () => {
    const {
      pluginDir: oversizedDir,
      manifestPath: oversizedPath,
      env,
    } = createPluginFixture("big-plugin", { id: "big-plugin", pad: "x".repeat(256 * 1024) });
    const goodPluginDir = path.join(path.dirname(oversizedDir), "good-plugin");
    writeJson(path.join(goodPluginDir, "openclaw.plugin.json"), { id: "good-plugin" });
    expect(fs.statSync(oversizedPath).size).toBeGreaterThan(256 * 1024);
    const records = listOpenClawPluginManifestMetadata(env);
    const cachedRecords = listOpenClawPluginManifestMetadata(env);

    expect(records.find((record) => record.manifest.id === "good-plugin")).toBeTruthy();
    expect(records.find((record) => record.manifest.id === "big-plugin")).toBeUndefined();
    expect(cachedRecords).toEqual(records);
    expect(warningMessagesForPath(oversizedPath)).toEqual([
      `Ignoring oversized plugin manifest at ${oversizedPath}: file exceeds the 262144-byte limit`,
    ]);
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
  ])("skips %s with at most one warning across cache hits", (name, contents, kind, error) => {
    const { pluginDir, manifestPath, env } = createPluginFixture("invalid-plugin", contents);
    if (name === "non-regular file") {
      fs.mkdirSync(manifestPath);
    }
    if (contents !== undefined) {
      const result = loadPluginManifest(pluginDir, false);
      assert(!result.ok);
    }
    for (let scan = 0; scan < 2; scan++) {
      expect(
        listOpenClawPluginManifestMetadata(env).find((record) => record.pluginDir === pluginDir),
      ).toBeUndefined();
    }
    expect(warningMessagesForPath(manifestPath)).toEqual(
      kind ? [`Ignoring ${kind} plugin manifest at ${manifestPath}: ${error}`] : [],
    );
  });

  it("accepts JSON5 manifests without warning when strict JSON parsing fails", () => {
    const contents = "{ id: 'json5-plugin', }";
    const { pluginDir, manifestPath, env } = createPluginFixture("json5-plugin", contents);
    expect(() => JSON.parse(contents)).toThrow();

    const records = listOpenClawPluginManifestMetadata(env);

    expect(records).toContainEqual({
      pluginDir,
      manifest: { id: "json5-plugin" },
      origin: "global",
    });
    expect(warningMessagesForPath(manifestPath)).toEqual([]);
  });

  it("accepts plugin manifests at the exact byte limit", () => {
    const exactManifest = { id: "exact-plugin", pad: "" };
    const compactJson = JSON.stringify(exactManifest);
    const requiredPadding = 256 * 1024 - Buffer.byteLength(compactJson, "utf8");
    exactManifest.pad = "x".repeat(requiredPadding);
    const { manifestPath: exactPath, env } = createPluginFixture("exact-plugin", exactManifest);
    expect(Buffer.byteLength(fs.readFileSync(exactPath), "utf8")).toBe(256 * 1024);

    expect(scanPlugin(env, "exact-plugin")).toBeTruthy();
  });
});
