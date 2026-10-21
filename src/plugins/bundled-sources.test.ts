import { bundledPluginRootAt } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBundledPluginSource, resolveBundledPluginSources } from "./bundled-sources.js";
import { resetPluginCache } from "./plugin-cache.js";

const appBundledPluginRoot = (pluginId: string) => bundledPluginRootAt("/app", pluginId);

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
  npm = true,
) {
  const packageName = `@openclaw/${id}`;
  return {
    origin,
    rootDir,
    ...(npm && { packageName, packageManifest: { install: { npmSpec: packageName } } }),
  };
}

function fixture(
  manifestIds: Record<string, string | { id: string; required?: string[] }>,
  candidates = Object.keys(manifestIds).map((id) => createBundledCandidate(id)),
) {
  discoverOpenClawPluginsMock.mockReturnValue({ candidates, diagnostics: [] });
  const manifestsByRoot = Object.fromEntries(
    Object.entries(manifestIds).map(([id, manifest]) => [appBundledPluginRoot(id), manifest]),
  );
  loadPluginManifestMock.mockImplementation((rootDir: string) => {
    const value = manifestsByRoot[rootDir];
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

function expectedSource(pluginId: string, configSchema?: Record<string, unknown>) {
  return {
    pluginId,
    localPath: appBundledPluginRoot(pluginId),
    npmSpec: `@openclaw/${pluginId}`,
    ...(configSchema ? { configSchema } : {}),
    requiresConfig: Boolean(configSchema),
  };
}

describe("bundled plugin sources", () => {
  beforeEach(() => {
    resetPluginCache();
    discoverOpenClawPluginsMock.mockReset();
    loadPluginManifestMock.mockReset();
  });
  afterEach(() => resetPluginCache());

  it("resolves bundled sources keyed by plugin id", () => {
    fixture({ feishu: "feishu", msteams: "msteams" }, [
      createBundledCandidate("feishu", "global", "/global/feishu"),
      createBundledCandidate("feishu"),
      createBundledCandidate("feishu", "bundled", appBundledPluginRoot("feishu-dup")),
      createBundledCandidate("msteams", "bundled", appBundledPluginRoot("msteams"), false),
    ]);
    const map = resolveBundledPluginSources({});

    expect(Array.from(map.keys())).toEqual(["feishu", "msteams"]);
    expect(map.get("feishu")).toEqual(expectedSource("feishu"));
    expect(map.get("msteams")).toEqual({
      pluginId: "msteams",
      localPath: appBundledPluginRoot("msteams"),
      requiresConfig: false,
    });
  });

  it.each([
    ["npmSpec", "@openclaw/feishu", "feishu"],
    ["npmSpec", "@openclaw/not-found", undefined],
    ["pluginId", "diffs", "diffs"],
    ["localPath", appBundledPluginRoot("diffs"), "diffs"],
    ["pluginId", "not-found", undefined],
  ] as const)("looks up %s %s", (kind, value, expectedId) => {
    fixture({ feishu: "feishu", diffs: "diffs" });
    const resolved = findBundledPluginSource({ lookup: { kind, value } });
    if (expectedId) {
      expect(resolved).toMatchObject({
        pluginId: expectedId,
        localPath: appBundledPluginRoot(expectedId),
      });
    } else {
      expect(resolved).toBeUndefined();
    }
  });

  it("marks bundled sources that require plugin config before activation", () => {
    fixture({
      "memory-lancedb": {
        id: "memory-lancedb",
        required: ["embedding"],
      },
    });

    expect(resolveBundledPluginSources({}).get("memory-lancedb")).toEqual(
      expectedSource("memory-lancedb", { type: "object", required: ["embedding"] }),
    );
  });
});
