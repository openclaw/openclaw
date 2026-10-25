import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundledPluginFile, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
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
  resolveSelectedPublishablePluginPackages,
  type PublishablePluginPackage,
} from "../scripts/lib/plugin-npm-release.ts";
import type { PluginPackageJson } from "../scripts/lib/plugin-publication-collector.ts";
import { isExternallyDistributedPlugin } from "../src/plugins/official-external-plugin-catalog.js";
import { createDeferred } from "./helpers/promise.js";
import { writePublishablePluginFixture } from "./helpers/publishable-plugin-fixture.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";

const tempDirs: string[] = [];
const version = "2026.4.10";
const makeRepo = () => makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-release-");
const makePlugin = (extensionId: string): PublishablePluginPackage => ({
  extensionId,
  packageDir: bundledPluginRoot(extensionId),
  packageName: `@openclaw/${extensionId}`,
  version: "2026.6.11",
  channel: "stable",
  publishTag: "latest",
});
const allPublishable = () =>
  collectPublishablePluginPackages().concat(collectClawHubPublishablePluginPackages());
const readPackage = (packageDir: string): PluginPackageJson =>
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const isExternal = (pluginId: string, packageJson: PluginPackageJson) =>
  isExternallyDistributedPlugin({
    pluginId,
    packageName: packageJson.name,
    packageBuild: packageJson.openclaw?.build,
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanupTempDirs(tempDirs);
});

it("requires the external plugin package compatibility contract for npm publish", () => {
  const { extensionId, packageDir } = writePublishablePluginFixture(makeRepo(), {
    extensionId: "voice-call",
    version: "2026.5.1-beta.1",
    publishTo: "npm",
  });
  const packageJson = readPackage(packageDir);
  delete packageJson.openclaw?.compat;
  delete packageJson.openclaw?.build;
  const errors = collectPublishablePluginPackageErrors({
    extensionId,
    packageDir,
    readmeText: "# Voice call\n",
    packageJson,
  });
  expect(errors).toEqual([
    "openclaw.compat.pluginApi is required for external code plugin packages.",
    "openclaw.build.openclawVersion is required for external code plugin packages.",
  ]);
});

it("warns once per stale dependency without blocking", () => {
  const plugin: PublishablePluginPackage = {
    ...makePlugin("codex"),
    requiredLatestDependencies: [{ packageName: "@openai/codex", version: "0.139.0" }],
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
});

it("fails closed when the registry refuses the published-version lookup", async () => {
  const repoDir = makeRepo();
  writePublishablePluginFixture(repoDir, { version, publishTo: "npm" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

  await expect(collectPluginReleasePlan({ rootDir: repoDir })).rejects.toThrow(
    "npm registry returned HTTP 401",
  );
});

it("bounds parallel registry reads and partitions every selected package", async () => {
  const repoDir = makeRepo();
  const names = Array.from({ length: 10 }, (_, index) => {
    const extensionId = `demo-${index}`;
    return writePublishablePluginFixture(repoDir, { extensionId, version, publishTo: "npm" })
      .packageName;
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

it("rejects duplicate npm package names from different plugin directories", () => {
  const repoDir = makeRepo();
  for (const extensionId of ["demo-one", "demo-two"]) {
    writePublishablePluginFixture(repoDir, {
      extensionId,
      packageName: "@openclaw/shared-plugin",
      version,
      publishTo: "npm",
    });
  }

  expect(() => collectPublishablePluginPackages(repoDir)).toThrow(
    "package @openclaw/shared-plugin is declared by multiple plugin sources: demo-one (extensions/demo-one), demo-two (extensions/demo-two).",
  );
});

it("keeps deferred publication targets bundled", () => {
  const bundledIds = new Set(collectBundledPluginBuildEntries({ env: {} }).map(({ id }) => id));
  const excludedDirs = collectRootPackageExcludedExtensionDirs();
  const publicationIds = new Set(allPublishable().map(({ extensionId }) => extensionId));
  for (const id of ["cua-computer", "logbook", "memory-wiki", "onepassword"]) {
    const packageJson = readPackage(join("extensions", id));
    expect(
      {
        bundled: bundledIds.has(id),
        excluded: excludedDirs.has(id),
        published: publicationIds.has(id),
        external: isExternal(id, packageJson),
      },
      id,
    ).toEqual({ bundled: true, excluded: false, published: false, external: false });
  }
});

it("rejects duplicate selected package provenance instead of choosing the last entry", () => {
  const firstPlugin = makePlugin("feishu");
  const plugins = [
    firstPlugin,
    { ...firstPlugin, extensionId: "feishu-shadow", packageDir: "extensions/feishu-shadow" },
  ];
  expect(() =>
    resolveSelectedPublishablePluginPackages({ plugins, selection: ["@openclaw/feishu"] }),
  ).toThrow("Plugin selection has conflicting plugin package provenance");
});

it("extracts unique extension ids from changed extension paths", () => {
  const paths = [
    bundledPluginFile("zalo", "index.ts"),
    bundledPluginFile("zalo", "package.json"),
    bundledPluginFile("feishu", "src/client.ts"),
    "docs/reference/RELEASING.md",
  ];
  expect(collectChangedExtensionIdsFromPaths(paths)).toEqual(["feishu", "zalo"]);
});
