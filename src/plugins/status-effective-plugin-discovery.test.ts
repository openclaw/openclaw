// `plugins doctor` reports effective-only plugins from the metadata snapshot it already
// built, so asking for effective ids must not re-derive plugin discovery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const counters = vi.hoisted(() => ({ metadataResolutions: 0, discoveryScans: 0 }));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-metadata-snapshot.js")>();
  return {
    ...actual,
    resolvePluginMetadataSnapshotAsync: (
      ...args: Parameters<typeof actual.resolvePluginMetadataSnapshotAsync>
    ) => {
      counters.metadataResolutions += 1;
      return actual.resolvePluginMetadataSnapshotAsync(...args);
    },
  };
});

vi.mock("./discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discovery.js")>();
  return {
    ...actual,
    discoverOpenClawPlugins: (...args: Parameters<typeof actual.discoverOpenClawPlugins>) => {
      counters.discoveryScans += 1;
      return actual.discoverOpenClawPlugins(...args);
    },
  };
});

const { buildPluginSnapshotReportAsync, withPluginDiagnosticsReport } = await import("./status.js");
const { resolveEffectivePluginIdsAsync } = await import("./effective-plugin-ids.js");
const { resolvePluginMetadataSnapshotAsync } = await import("./plugin-metadata-snapshot.js");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-effective-plugin-ids-"));

function coldPluginRoot(pluginId: string, channelId: string): string {
  const rootDir = path.join(tempRoot, pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  createColdPluginFixture({
    rootDir,
    pluginId,
    channelId,
    providerId: `${pluginId}-provider`,
    packageName: `@example/${pluginId}`,
  });
  return rootDir;
}

const channelOwnerRoot = coldPluginRoot("cold-plugin", "cold-channel");
const otherRoot = coldPluginRoot("other-plugin", "other-channel");

const config: OpenClawConfig = {
  channels: { "cold-channel": { enabled: true } },
  plugins: {
    load: { paths: [channelOwnerRoot, otherRoot] },
    entries: { "cold-plugin": { enabled: true }, "other-plugin": { enabled: true } },
  },
} as OpenClawConfig;

async function countReport(params: {
  effectiveOnly: boolean;
  onlyPluginIds?: readonly string[];
}): Promise<{
  resolutions: number;
  scans: number;
  ids: string[];
}> {
  counters.metadataResolutions = 0;
  counters.discoveryScans = 0;
  return withPluginDiagnosticsReport({ config, env: process.env, ...params }, (report) => ({
    resolutions: counters.metadataResolutions,
    scans: counters.discoveryScans,
    ids: report.plugins.map((plugin) => plugin.id).toSorted(),
  }));
}

async function countResolve(metadataSnapshot: PluginMetadataSnapshot): Promise<{
  resolutions: number;
  scans: number;
  ids: string[];
}> {
  counters.metadataResolutions = 0;
  counters.discoveryScans = 0;
  const ids = await resolveEffectivePluginIdsAsync({ config, env: process.env, metadataSnapshot });
  return { resolutions: counters.metadataResolutions, scans: counters.discoveryScans, ids };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("does not re-derive discovery when reporting effective-only plugins", async () => {
  const all = await countReport({ effectiveOnly: false });
  clearPluginMetadataLifecycleCaches();
  const effective = await countReport({ effectiveOnly: true });

  // The effective-only filter still selects the configured channel owner.
  expect(effective.ids).toEqual(["cold-plugin", "other-plugin"]);
  // ...and it reuses the snapshot the report already built instead of rediscovering.
  expect({
    resolutions: effective.resolutions,
    scansMoreThanFullReport: effective.scans > all.scans,
  }).toEqual({ resolutions: all.resolutions, scansMoreThanFullReport: false });
});

it.each([
  { onlyPluginIds: undefined, expected: ["cold-plugin", "other-plugin"] },
  { onlyPluginIds: [" other-plugin ", "missing-plugin"], expected: ["other-plugin"] },
  { onlyPluginIds: [], expected: [] },
])(
  "keeps effective snapshot reports within explicit scope $onlyPluginIds",
  async ({ onlyPluginIds, expected }) => {
    const metadataSnapshot = await resolvePluginMetadataSnapshotAsync({ config, env: process.env });
    const report = await buildPluginSnapshotReportAsync({
      config,
      env: process.env,
      metadataSnapshot,
      effectiveOnly: true,
      onlyPluginIds,
    });

    expect(report.plugins.map((plugin) => plugin.id).toSorted()).toEqual(expected);
  },
);

// A supplied snapshot is an optimization, never an input to the answer.
it("only reuses a snapshot that answers for the whole config", async () => {
  const env = process.env;
  const fullSnapshot = await resolvePluginMetadataSnapshotAsync({ config, env });
  clearPluginMetadataLifecycleCaches();
  const full = await countResolve(fullSnapshot);
  const withoutSnapshot = await resolveEffectivePluginIdsAsync({ config, env });
  clearPluginMetadataLifecycleCaches();
  // `recordPluginInstallSource` asks for one plugin's effective state, which scopes the
  // snapshot to that plugin and truncates its manifest set to that plugin alone.
  const scopedSnapshot = await resolvePluginMetadataSnapshotAsync({
    config,
    env,
    pluginIds: ["other-plugin"],
  });
  clearPluginMetadataLifecycleCaches();
  const scoped = await countResolve(scopedSnapshot);

  expect({ full: full.ids, scoped: scoped.ids }).toEqual({
    full: withoutSnapshot,
    scoped: withoutSnapshot,
  });
  expect(full.scans).toBe(0);
  // A whole-config snapshot is reused; a plugin-scoped one cannot stand in for it.
  expect({ fullReused: full.resolutions === 0, scopedReused: scoped.resolutions === 0 }).toEqual({
    fullReused: true,
    scopedReused: false,
  });
});
