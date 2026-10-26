import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const counters = vi.hoisted(() => ({ manifestRegistryRebuilds: 0, discoveryScans: 0 }));

vi.mock("../config/io.plugin-metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.plugin-metadata.js")>();
  return {
    ...actual,
    resolveConfigWidePluginManifestRegistry: (
      ...args: Parameters<typeof actual.resolveConfigWidePluginManifestRegistry>
    ) => {
      counters.manifestRegistryRebuilds += 1;
      return actual.resolveConfigWidePluginManifestRegistry(...args);
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
const { resolveEffectivePluginIds } = await import("./effective-plugin-ids.js");
const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");

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

function counts(ids: string[]) {
  return { rebuilds: counters.manifestRegistryRebuilds, scans: counters.discoveryScans, ids };
}

function resetCounters() {
  counters.manifestRegistryRebuilds = 0;
  counters.discoveryScans = 0;
}

async function countReport(effectiveOnly: boolean) {
  resetCounters();
  return withPluginDiagnosticsReport({ config, env: process.env, effectiveOnly }, (report) =>
    counts(report.plugins.map((plugin) => plugin.id).toSorted()),
  );
}

function countResolve(metadataSnapshot: PluginMetadataSnapshot) {
  resetCounters();
  return counts(resolveEffectivePluginIds({ config, env: process.env, metadataSnapshot }));
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
});

afterEach(clearPluginMetadataLifecycleCaches);

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("does not re-derive discovery when reporting effective-only plugins", async () => {
  const all = await countReport(false);
  clearPluginMetadataLifecycleCaches();
  const effective = await countReport(true);

  expect(effective.ids).toEqual(["cold-plugin", "other-plugin"]);
  expect(effective.rebuilds).toBe(0);
  expect(effective.scans).toBeLessThanOrEqual(all.scans);
});

it.each([
  { onlyPluginIds: undefined, expected: ["cold-plugin", "other-plugin"] },
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
  expect(full.scans).toBe(0);
  expect(full.rebuilds).toBe(0);
  expect(scoped.rebuilds).not.toBe(0);
});
