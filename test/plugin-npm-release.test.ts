// Plugin npm release tests validate plugin npm release artifacts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundledPluginFile, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectBundledPluginBuildEntries,
  collectRootPackageExcludedExtensionDirs,
} from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { collectClawHubPublishablePluginPackages } from "../scripts/lib/plugin-clawhub-release.ts";
import {
  assertPluginReleaseDependencyFreshness,
  collectChangedExtensionIdsFromPaths,
  collectPluginReleasePlan,
  collectPublishablePluginPackages,
  collectPublishablePluginPackageErrors,
  OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
  resolveSelectedPublishablePluginPackages,
  type PublishablePluginPackage,
} from "../scripts/lib/plugin-npm-release.ts";
import type { PluginPackageJson } from "../scripts/lib/plugin-publication-collector.ts";
import { isExternallyDistributedPlugin } from "../src/plugins/official-external-plugin-catalog.js";
import { createDeferred } from "./helpers/promise.js";
import { writePublishablePluginFixture } from "./helpers/publishable-plugin-fixture.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";

type ExecFileSync = typeof execFileSync;

const childProcessMock = vi.hoisted(() => ({
  execFileSyncOverride: undefined as ExecFileSync | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const mockedExecFileSync = ((...args: unknown[]) => {
    const implementation = (childProcessMock.execFileSyncOverride ?? actual.execFileSync) as (
      ...args: unknown[]
    ) => unknown;
    return implementation(...args);
  }) as ExecFileSync;
  return { ...actual, execFileSync: mockedExecFileSync };
});

const tempDirs: string[] = [];

afterEach(() => {
  childProcessMock.execFileSyncOverride = undefined;
  vi.unstubAllGlobals();
  cleanupTempDirs(tempDirs);
});

describe("collectPublishablePluginPackageErrors", () => {
  it("requires the external plugin package compatibility contract for npm publish", () => {
    expect(
      collectPublishablePluginPackageErrors({
        extensionId: "voice-call",
        packageDir: bundledPluginRoot("voice-call"),
        readmeText: "# Voice call\n",
        packageJson: {
          name: "@openclaw/voice-call",
          version: "2026.5.1-beta.1",
          type: "module",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            install: {
              npmSpec: "@openclaw/voice-call",
            },
            release: {
              publishToNpm: true,
            },
          },
        },
      }),
    ).toEqual([
      "openclaw.compat.pluginApi is required for external code plugin packages.",
      "openclaw.build.openclawVersion is required for external code plugin packages.",
    ]);
  });
});

describe("collectPluginReleaseDependencyFreshnessWarnings", () => {
  const plugin: PublishablePluginPackage = {
    extensionId: "codex",
    packageDir: "extensions/codex",
    packageName: "@openclaw/codex",
    version: "2026.6.11",
    channel: "stable",
    publishTag: "latest",
    requiredLatestDependencies: [
      {
        packageName: "@openai/codex",
        version: "0.139.0",
      },
    ],
  };

  afterEach(() => vi.restoreAllMocks());

  it("warns once per stale dependency without blocking or inspecting Git", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const git = vi.fn(() => {
      throw new Error("not a Git checkout");
    });
    childProcessMock.execFileSyncOverride = git as unknown as ExecFileSync;
    const resolveLatest = vi.fn(() => "0.153.0");
    const warnings = assertPluginReleaseDependencyFreshness(
      [plugin, { ...plugin, packageName: "@openclaw/another-harness" }],
      "release check",
      resolveLatest,
    );

    expect(warnings).toEqual([
      '@openclaw/codex@2026.6.11: @openai/codex pinned "0.139.0", npm latest is "0.153.0". Freshness is advisory; retain the release-validated pin.',
      '@openclaw/another-harness@2026.6.11: @openai/codex pinned "0.139.0", npm latest is "0.153.0". Freshness is advisory; retain the release-validated pin.',
    ]);
    expect(warn.mock.calls).toEqual(
      warnings.map((warning) => [`release check: warning: ${warning}`]),
    );
    expect(resolveLatest).toHaveBeenCalledExactlyOnceWith("@openai/codex");
    expect(git).not.toHaveBeenCalled();
  });
});

describe("collectPluginReleasePlan", () => {
  it("fails closed when the registry refuses the published-version lookup", async () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    writePublishablePluginFixture(repoDir, {
      version: "2026.4.10",
      publishTo: "npm",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(collectPluginReleasePlan({ rootDir: repoDir })).rejects.toThrow(
      "npm registry returned HTTP 401",
    );
  });

  it("bounds parallel registry reads and partitions every selected package", async () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    const version = "2026.4.10";
    const names = Array.from({ length: 10 }, (_, index) => {
      const extensionId = `demo-${index}`;
      return writePublishablePluginFixture(repoDir, {
        extensionId,
        version,
        publishTo: "npm",
      }).packageName;
    });
    const release = createDeferred();
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async (url: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await release.promise;
      active -= 1;
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      if (name === names[0]) {
        return new Response(null, { status: 404 });
      }
      const versions = names.indexOf(name) % 2 === 0 ? { [version]: { version } } : {};
      return Response.json({ versions });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = collectPluginReleasePlan({ rootDir: repoDir });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    } finally {
      release.resolve();
      await pending;
    }
    const plan = await pending;

    expect(maximumActive).toBe(8);
    expect(plan.all.map((plugin) => plugin.packageName)).toEqual(names);
    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(
      names.filter((_, index) => index === 0 || index % 2 === 1),
    );
    expect(plan.skippedPublished.map((plugin) => plugin.packageName)).toEqual(
      names.filter((_, index) => index !== 0 && index % 2 === 0),
    );
    expect(fetchMock).toHaveBeenCalledTimes(names.length);
  });
});

describe("collectPublishablePluginPackages", () => {
  it("rejects duplicate npm package names from different plugin directories", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
    for (const extensionId of ["demo-one", "demo-two"]) {
      writePublishablePluginFixture(repoDir, {
        extensionId,
        packageName: "@openclaw/shared-plugin",
        version: "2026.4.10",
        publishTo: "npm",
      });
    }

    expect(() => collectPublishablePluginPackages(repoDir)).toThrow(
      "package @openclaw/shared-plugin is declared by multiple plugin sources: demo-one (extensions/demo-one), demo-two (extensions/demo-two).",
    );
  });

  it("keeps publishable plugin dist trees out of the core npm package unless bundled", () => {
    const excludedDirs = collectRootPackageExcludedExtensionDirs();
    const publishablePlugins = [
      ...collectPublishablePluginPackages(),
      ...collectClawHubPublishablePluginPackages(),
    ];
    for (const plugin of publishablePlugins) {
      const packageJson = JSON.parse(
        readFileSync(join(plugin.packageDir, "package.json"), "utf8"),
      ) as PluginPackageJson;
      expect(excludedDirs.has(plugin.extensionId), plugin.extensionId).toBe(
        isExternallyDistributedPlugin({
          pluginId: plugin.extensionId,
          packageName: plugin.packageName,
          packageBuild: packageJson.openclaw?.build,
        }),
      );
    }
  });

  it("keeps deferred publication targets bundled with staged release metadata", () => {
    const bundledIds = collectBundledPluginBuildEntries({ env: {} }).map(({ id }) => id);
    const excludedDirs = collectRootPackageExcludedExtensionDirs();
    const publicationIds = new Set(
      [...collectPublishablePluginPackages(), ...collectClawHubPublishablePluginPackages()].map(
        ({ extensionId }) => extensionId,
      ),
    );
    for (const { id, minHostVersion, publishToNpm = true } of [
      { id: "cua-computer", minHostVersion: ">=2026.9.6", publishToNpm: false },
      { id: "logbook", minHostVersion: ">=2026.9.5" },
      { id: "memory-wiki", minHostVersion: ">=2026.9.4" },
      { id: "onepassword", minHostVersion: ">=2026.9.4" },
    ]) {
      const packageJson = JSON.parse(
        readFileSync(join("extensions", id, "package.json"), "utf8"),
      ) as PluginPackageJson;
      expect(packageJson, id).toMatchObject({
        name: `@openclaw/${id}`,
        openclaw: {
          build: { bundledDist: true },
          install: { minHostVersion },
          release: { publishToNpm, publishToClawHub: true },
        },
      });
      expect(bundledIds, id).toContain(id);
      expect(excludedDirs.has(id), id).toBe(false);
      expect(publicationIds.has(id), id).toBe(false);
      expect(
        isExternallyDistributedPlugin({
          pluginId: id,
          packageName: packageJson.name,
          packageBuild: packageJson.openclaw?.build,
        }),
        id,
      ).toBe(false);
    }
  });
});

describe("resolveSelectedPublishablePluginPackages", () => {
  const publishablePlugins: PublishablePluginPackage[] = [
    {
      extensionId: "feishu",
      packageDir: bundledPluginRoot("feishu"),
      packageName: "@openclaw/feishu",
      version: "2026.3.15",
      channel: "stable",
      publishTag: "latest",
    },
    {
      extensionId: "zalo",
      packageDir: bundledPluginRoot("zalo"),
      packageName: "@openclaw/zalo",
      version: "2026.3.15-beta.1",
      channel: "beta",
      publishTag: "beta",
    },
  ];

  it("rejects duplicate selected package provenance instead of choosing the last entry", () => {
    const firstPlugin = publishablePlugins[0];
    if (!firstPlugin) {
      throw new Error("publishable plugin fixture is missing");
    }
    expect(() =>
      resolveSelectedPublishablePluginPackages({
        plugins: [
          firstPlugin,
          {
            ...firstPlugin,
            extensionId: "feishu-shadow",
            packageDir: "extensions/feishu-shadow",
          },
        ],
        selection: ["@openclaw/feishu"],
      }),
    ).toThrow("Plugin selection has conflicting plugin package provenance");
  });
});

describe("collectChangedExtensionIdsFromPaths", () => {
  it("extracts unique extension ids from changed extension paths", () => {
    expect(
      collectChangedExtensionIdsFromPaths([
        bundledPluginFile("zalo", "index.ts"),
        bundledPluginFile("zalo", "package.json"),
        bundledPluginFile("feishu", "src/client.ts"),
        "docs/reference/RELEASING.md",
      ]),
    ).toEqual(["feishu", "zalo"]);
  });
});
