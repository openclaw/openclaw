import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as configMetadata from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as discovery from "./discovery.js";
import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { buildPluginSnapshotReportAsync, withPluginDiagnosticsReport } from "./status.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-effective-plugin-ids-"));

const pluginIds = ["cold-plugin", "other-plugin"];
const roots = pluginIds.map((pluginId) => {
  const rootDir = path.join(tempRoot, pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  createColdPluginFixture({
    rootDir,
    pluginId,
    channelId: pluginId.replace("plugin", "channel"),
    providerId: `${pluginId}-provider`,
    packageName: `@example/${pluginId}`,
  });
  return rootDir;
});

const config: OpenClawConfig = {
  channels: { "cold-channel": { enabled: true } },
  plugins: {
    load: { paths: roots },
    entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
  },
} as OpenClawConfig;

function counts(ids: string[]) {
  return {
    rebuilds: vi.mocked(configMetadata.resolveConfigWidePluginManifestRegistry).mock.calls.length,
    scans: vi.mocked(discovery.discoverOpenClawPlugins).mock.calls.length,
    ids,
  };
}

async function countReport(effectiveOnly: boolean) {
  vi.clearAllMocks();
  return withPluginDiagnosticsReport({ config, env: process.env, effectiveOnly }, (report) =>
    counts(report.plugins.map((plugin) => plugin.id).toSorted()),
  );
}

function countResolve(metadataSnapshot: PluginMetadataSnapshot) {
  vi.clearAllMocks();
  return counts(resolveEffectivePluginIds({ config, env: process.env, metadataSnapshot }));
}

beforeEach(() => {
  vi.spyOn(configMetadata, "resolveConfigWidePluginManifestRegistry");
  vi.spyOn(discovery, "discoverOpenClawPlugins");
  clearPluginMetadataLifecycleCaches();
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("does not re-derive discovery when reporting effective-only plugins", async () => {
  const all = await countReport(false);
  clearPluginMetadataLifecycleCaches();
  const effective = await countReport(true);

  expect(effective).toMatchObject({ ids: pluginIds, rebuilds: 0 });
  expect(effective.scans).toBeLessThanOrEqual(all.scans);
});

it.each([
  { onlyPluginIds: undefined, expected: pluginIds },
  { onlyPluginIds: [" other-plugin ", "missing-plugin"], expected: ["other-plugin"] },
  { onlyPluginIds: [], expected: [] },
])(
  "keeps effective snapshot reports within explicit scope $onlyPluginIds",
  async ({ onlyPluginIds, expected }) => {
    const metadataSnapshot = loadPluginMetadataSnapshot({ config, env: process.env });
    const report = await buildPluginSnapshotReportAsync({
      config,
      env: process.env,
      metadataSnapshot,
      onlyPluginIds,
    });

    expect(report.plugins.map((plugin) => plugin.id).toSorted()).toEqual(expected);
  },
);

it("only reuses a snapshot that answers for the whole config", () => {
  const env = process.env;
  const fullSnapshot = loadPluginMetadataSnapshot({ config, env });
  clearPluginMetadataLifecycleCaches();
  const full = countResolve(fullSnapshot);
  const withoutSnapshot = resolveEffectivePluginIds({ config, env });
  clearPluginMetadataLifecycleCaches();
  // A scoped install-source lookup must not truncate a whole-config answer.
  const scopedSnapshot = loadPluginMetadataSnapshot({ config, env, pluginIds: ["other-plugin"] });
  clearPluginMetadataLifecycleCaches();
  const scoped = countResolve(scopedSnapshot);

  expect([full.ids, scoped.ids]).toEqual([withoutSnapshot, withoutSnapshot]);
  expect(full).toMatchObject({ scans: 0, rebuilds: 0 });
  expect(scoped.rebuilds).not.toBe(0);
});
