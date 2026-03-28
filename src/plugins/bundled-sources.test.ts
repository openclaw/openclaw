import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findBundledPluginSource,
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
} from "./bundled-sources.js";

const discoverOpenClawPluginsMock = vi.fn();
const loadPluginManifestMock = vi.fn();

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: (...args: unknown[]) => discoverOpenClawPluginsMock(...args),
}));

vi.mock("./manifest.js", () => ({
  loadPluginManifest: (...args: unknown[]) => loadPluginManifestMock(...args),
}));

function createBundledCandidate(params: {
  rootDir: string;
  packageName: string;
  npmSpec?: string;
  origin?: "bundled" | "global";
}) {
  return {
    origin: params.origin ?? "bundled",
    rootDir: params.rootDir,
    packageName: params.packageName,
    packageManifest: {
      install: {
        npmSpec: params.npmSpec ?? params.packageName,
      },
    },
  };
}

function setBundledDiscoveryCandidates(candidates: unknown[]) {
  discoverOpenClawPluginsMock.mockReturnValue({
    candidates,
    diagnostics: [],
  });
}

function setBundledManifestIdsByRoot(manifestIds: Record<string, string>) {
  loadPluginManifestMock.mockImplementation((rootDir: string) =>
    rootDir in manifestIds
      ? { ok: true, manifest: { id: manifestIds[rootDir] } }
      : {
          ok: false,
          error: "invalid manifest",
          manifestPath: `${rootDir}/openclaw.plugin.json`,
        },
  );
}

function expectBundledSourceLookup(
  lookup: Parameters<typeof findBundledPluginSource>[0]["lookup"],
  expected:
    | {
        pluginId: string;
        localPath: string;
      }
    | undefined,
) {
  const resolved = findBundledPluginSource({ lookup });
  if (!expected) {
    expect(resolved).toBeUndefined();
    return;
  }
  expect(resolved?.pluginId).toBe(expected.pluginId);
  expect(resolved?.localPath).toBe(expected.localPath);
}

describe("bundled plugin sources", () => {
  beforeEach(() => {
    discoverOpenClawPluginsMock.mockReset();
    loadPluginManifestMock.mockReset();
  });

  it("resolves bundled sources keyed by plugin id", () => {
    setBundledDiscoveryCandidates([
      createBundledCandidate({
        origin: "global",
        rootDir: "/global/feishu",
        packageName: "@openclaw/feishu",
      }),
      createBundledCandidate({
        rootDir: "/app/extensions/feishu",
        packageName: "@openclaw/feishu",
      }),
      createBundledCandidate({
        rootDir: "/app/extensions/feishu-dup",
        packageName: "@openclaw/feishu",
      }),
      createBundledCandidate({
        rootDir: "/app/extensions/msteams",
        packageName: "@openclaw/msteams",
      }),
    ]);
    setBundledManifestIdsByRoot({
      "/app/extensions/feishu": "feishu",
      "/app/extensions/msteams": "msteams",
    });

    const map = resolveBundledPluginSources({});

    expect(Array.from(map.keys())).toEqual(["feishu", "msteams"]);
    expect(map.get("feishu")).toEqual({
      pluginId: "feishu",
      localPath: "/app/extensions/feishu",
      npmSpec: "@openclaw/feishu",
    });
  });

  it.each([
    [
      "finds bundled source by npm spec",
      { kind: "npmSpec", value: "@openclaw/feishu" } as const,
      { pluginId: "feishu", localPath: "/app/extensions/feishu" },
    ],
    [
      "returns undefined for missing npm spec",
      { kind: "npmSpec", value: "@openclaw/not-found" } as const,
      undefined,
    ],
    [
      "finds bundled source by plugin id",
      { kind: "pluginId", value: "diffs" } as const,
      { pluginId: "diffs", localPath: "/app/extensions/diffs" },
    ],
    [
      "returns undefined for missing plugin id",
      { kind: "pluginId", value: "not-found" } as const,
      undefined,
    ],
  ] as const)("%s", (_name, lookup, expected) => {
    setBundledDiscoveryCandidates([
      createBundledCandidate({
        rootDir: "/app/extensions/feishu",
        packageName: "@openclaw/feishu",
      }),
      createBundledCandidate({
        rootDir: "/app/extensions/diffs",
        packageName: "@openclaw/diffs",
      }),
    ]);
    setBundledManifestIdsByRoot({
      "/app/extensions/feishu": "feishu",
      "/app/extensions/diffs": "diffs",
    });
    expectBundledSourceLookup(lookup, expected);
  });

  it("forwards an explicit env to bundled discovery helpers", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [],
      diagnostics: [],
    });

    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    resolveBundledPluginSources({
      workspaceDir: "/workspace",
      env,
    });
    findBundledPluginSource({
      lookup: { kind: "pluginId", value: "feishu" },
      workspaceDir: "/workspace",
      env,
    });

    expect(discoverOpenClawPluginsMock).toHaveBeenNthCalledWith(1, {
      workspaceDir: "/workspace",
      env,
    });
    expect(discoverOpenClawPluginsMock).toHaveBeenNthCalledWith(2, {
      workspaceDir: "/workspace",
      env,
    });
  });

  it("reuses a pre-resolved bundled map for repeated lookups", () => {
    const bundled = new Map([
      [
        "feishu",
        {
          pluginId: "feishu",
          localPath: "/app/extensions/feishu",
          npmSpec: "@openclaw/feishu",
        },
      ],
    ]);

    expect(
      findBundledPluginSourceInMap({
        bundled,
        lookup: { kind: "pluginId", value: "feishu" },
      }),
    ).toEqual({
      pluginId: "feishu",
      localPath: "/app/extensions/feishu",
      npmSpec: "@openclaw/feishu",
    });
    expect(
      findBundledPluginSourceInMap({
        bundled,
        lookup: { kind: "npmSpec", value: "@openclaw/feishu" },
      })?.pluginId,
    ).toBe("feishu");
  });
});
