/** Covers bundled plugin source overlays and packaged load-path decisions. */
import { bundledPluginRootAt } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findBundledPluginSource,
  getProcessBundledPluginSources,
  resolveBundledPluginSources,
} from "./bundled-sources.js";
import { setCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import { resetPluginCache } from "./plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const APP_ROOT = "/app";

function appBundledPluginRoot(pluginId: string): string {
  return bundledPluginRootAt(APP_ROOT, pluginId);
}

const discoverOpenClawPluginsMock = vi.fn();
const loadPluginManifestMock = vi.fn();

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: (...args: unknown[]) => discoverOpenClawPluginsMock(...args),
}));

vi.mock("./manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest.js")>()),
  loadPluginManifest: (...args: unknown[]) => loadPluginManifestMock(...args),
}));

function createBundledCandidate(
  id: string,
  origin: "bundled" | "global" = "bundled",
  rootDir = appBundledPluginRoot(id),
) {
  const packageName = `@openclaw/${id}`;
  return {
    origin,
    rootDir,
    packageName,
    packageManifest: { install: { npmSpec: packageName } },
  };
}

function setBundledDiscoveryCandidates(candidates: unknown[]) {
  discoverOpenClawPluginsMock.mockReturnValue({
    candidates,
    diagnostics: [],
  });
}

function setBundledManifestIdsByRoot(
  manifestIds: Record<string, string | { id: string; required?: string[] }>,
) {
  loadPluginManifestMock.mockImplementation((rootDir: string) => {
    const value = manifestIds[rootDir];
    return value === undefined
      ? { ok: false, error: "invalid manifest", manifestPath: `${rootDir}/openclaw.plugin.json` }
      : {
          ok: true,
          manifest:
            typeof value === "string"
              ? { id: value }
              : {
                  id: value.id,
                  configSchema: { type: "object", required: value.required },
                },
        };
  });
}

function setBundledLookupFixture() {
  setBundledDiscoveryCandidates([
    createBundledCandidate("feishu"),
    createBundledCandidate("diffs"),
  ]);
  setBundledManifestIdsByRoot({
    [appBundledPluginRoot("feishu")]: "feishu",
    [appBundledPluginRoot("diffs")]: "diffs",
  });
}

function expectedSource(pluginId: string, configSchema?: Record<string, unknown>) {
  return {
    pluginId,
    localPath: appBundledPluginRoot(pluginId),
    npmSpec: `@openclaw/${pluginId}`,
    ...(configSchema ? { configSchema } : {}),
    requiresConfig: Boolean(configSchema),
  };
}

function expectBundledSourceLookup(
  lookup: Parameters<typeof findBundledPluginSource>[0]["lookup"],
  expected: Pick<ReturnType<typeof expectedSource>, "pluginId" | "localPath"> | undefined,
) {
  const resolved = findBundledPluginSource({ lookup });
  if (!expected) {
    expect(resolved).toBeUndefined();
    return;
  }
  expect(resolved).toMatchObject(expected);
}

describe("bundled plugin sources", () => {
  beforeEach(() => {
    resetPluginCache();
    discoverOpenClawPluginsMock.mockReset();
    loadPluginManifestMock.mockReset();
  });
  afterEach(() => resetPluginCache());

  it("projects bundled sources from the Gateway inventory without rediscovery", () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "feishu", rootDir: appBundledPluginRoot("feishu") }],
    });
    snapshot.bundledManifestRegistry = snapshot.manifestRegistry;
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      undefined,
      undefined,
      undefined,
      undefined,
      "gateway",
    );

    const first = getProcessBundledPluginSources();
    const second = getProcessBundledPluginSources();

    expect([...first.values()]).toEqual([
      { pluginId: "feishu", localPath: appBundledPluginRoot("feishu"), requiresConfig: false },
    ]);
    expect(second).toEqual(first);
    expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();
    expect(loadPluginManifestMock).not.toHaveBeenCalled();
  });

  it("resolves bundled sources keyed by plugin id", () => {
    setBundledDiscoveryCandidates([
      createBundledCandidate("feishu", "global", "/global/feishu"),
      createBundledCandidate("feishu"),
      createBundledCandidate("feishu", "bundled", appBundledPluginRoot("feishu-dup")),
      createBundledCandidate("msteams"),
    ]);
    setBundledManifestIdsByRoot({
      [appBundledPluginRoot("feishu")]: "feishu",
      [appBundledPluginRoot("msteams")]: "msteams",
    });

    const map = resolveBundledPluginSources({});

    expect(Array.from(map.keys())).toEqual(["feishu", "msteams"]);
    expect(map.get("feishu")).toEqual(expectedSource("feishu"));
  });

  it.each([
    [
      "finds bundled source by npm spec",
      { kind: "npmSpec", value: "@openclaw/feishu" } as const,
      { pluginId: "feishu", localPath: appBundledPluginRoot("feishu") },
    ],
    [
      "returns undefined for missing npm spec",
      { kind: "npmSpec", value: "@openclaw/not-found" } as const,
      undefined,
    ],
    [
      "finds bundled source by plugin id",
      { kind: "pluginId", value: "diffs" } as const,
      { pluginId: "diffs", localPath: appBundledPluginRoot("diffs") },
    ],
    [
      "finds bundled source by local path",
      { kind: "localPath", value: appBundledPluginRoot("diffs") } as const,
      { pluginId: "diffs", localPath: appBundledPluginRoot("diffs") },
    ],
    [
      "returns undefined for missing plugin id",
      { kind: "pluginId", value: "not-found" } as const,
      undefined,
    ],
  ] as const)("%s", (_name, lookup, expected) => {
    setBundledLookupFixture();
    expectBundledSourceLookup(lookup, expected);
  });

  it("marks bundled sources that require plugin config before activation", () => {
    setBundledDiscoveryCandidates([createBundledCandidate("memory-lancedb")]);
    setBundledManifestIdsByRoot({
      [appBundledPluginRoot("memory-lancedb")]: {
        id: "memory-lancedb",
        required: ["embedding"],
      },
    });

    expect(resolveBundledPluginSources({}).get("memory-lancedb")).toEqual(
      expectedSource("memory-lancedb", { type: "object", required: ["embedding"] }),
    );
  });
});
