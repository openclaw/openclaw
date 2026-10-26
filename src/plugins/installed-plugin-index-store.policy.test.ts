import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import {
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import { createInstalledPluginIndexCandidate as createCandidate } from "./test-helpers/installed-plugin-index.js";

const temp = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const makeTempDir = () => temp.make("openclaw-installed-plugin-index-policy-");
const env = {
  OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  OPENCLAW_VERSION: "2026.4.25",
  VITEST: "true",
};
const disablePlugin = (id: string) => ({
  config: { plugins: { entries: { [id]: { enabled: false } } } },
  policyPluginIds: [id],
});

function makeFixture(owner?: string) {
  const stateDir = makeTempDir();
  const pluginDir = path.join(stateDir, "plugins", "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  const candidate = recordPluginCandidateInstallOwner(createCandidate(pluginDir), owner);
  const candidates = [candidate];
  const refresh = (params: Parameters<typeof refreshPersistedInstalledPluginIndex>[0]) =>
    refreshPersistedInstalledPluginIndex({ stateDir, candidates, env, ...params });
  const read = () => readPersistedInstalledPluginIndex({ stateDir });
  const write = (index: InstalledPluginIndex) =>
    writePersistedInstalledPluginIndex(index, { stateDir });
  return { stateDir, pluginDir, candidate, candidates, refresh, read, write };
}

it("preserves admitted source during policy refresh and refuses publication under its lease", async () => {
  const { stateDir, pluginDir, candidate, refresh, read } = makeFixture("package");
  const installRecords = {
    package: { source: "git", installPath: pluginDir },
    orphaned: { source: "path", installPath: path.join(stateDir, "missing") },
  } satisfies InstalledPluginIndex["installRecords"];
  const initial = await refresh({ reason: "manual", installRecords });
  expect(initial.plugins[0]).toMatchObject({ pluginId: "demo", installOwner: "package" });
  const admissionKey = pluginDir + "\0";
  const admission = {
    signature: "admitted-source",
    sourceDigest: "a".repeat(64),
    nativeArtifacts: {},
    nativeNamespaces: {},
  };
  const latestAdmission = { ...admission, signature: "readmitted-source" };
  const newerAdmission = { ...admission, signature: "source-observed-during-refresh" };
  const publication = {
    pluginId: "demo",
    rootDir: fs.realpathSync(pluginDir),
    installRecordHash: initial.plugins[0]?.installRecordHash,
    key: admissionKey,
  };
  const publish = (receipt: typeof admission) =>
    createPluginSourceAdmissionPublisher({ stateDir })!({ ...publication, receipt });
  expect(await publish(admission)).toBe(true);
  expect(Object.keys((await read())!.installRecords)).toEqual(["orphaned", "package"]);
  expect(await publish(latestAdmission)).toBe(true);
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  const manifest: { providers: string[] } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.providers = ["demo", "changed"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

  const refreshed = await withPluginLifecycleLease(
    resolveInstalledPluginIndexStateDatabaseOptions({ stateDir, env }),
    async (lease) => {
      const current = await refresh({
        lease,
        reason: "policy-changed",
        installRecords,
        ...disablePlugin("demo"),
      });
      expect(await publish(newerAdmission)).toBe(false);
      return current;
    },
  );

  expect(refreshed.plugins).toHaveLength(initial.plugins.length);
  expect(refreshed.plugins.find((plugin) => plugin.pluginId === "demo")).toMatchObject({
    pluginId: "demo",
    enabled: false,
    manifestHash: initial.plugins[0]?.manifestHash,
    sourceAdmissions: { [admissionKey]: latestAdmission },
  });
  expect((await read())?.plugins[0]?.sourceAdmissions).toEqual({
    [admissionKey]: latestAdmission,
  });
  expect(refreshed.policyHash).not.toBe(initial.policyHash);

  const rebuilt = await refresh({
    reason: "policy-changed",
    candidates: undefined,
    discovery: { candidates: [candidate], diagnostics: [] },
    installRecords: { ...installRecords, package: { ...installRecords.package, source: "npm" } },
  });
  expect(rebuilt.plugins[0]).toMatchObject({ pluginId: "demo", installOwner: "package" });
  expect(rebuilt.plugins[0]?.manifestHash).not.toBe(initial.plugins[0]?.manifestHash);
  expect(rebuilt.plugins[0]?.sourceAdmissions).toBeUndefined();
});

it.each(["policy target", "installed projection"] as const)(
  "rebuilds source when the %s is missing",
  async (missing) => {
    const { stateDir, pluginDir, candidates, refresh, read, write } = makeFixture();
    const installRecords: InstalledPluginIndex["installRecords"] | undefined =
      missing === "installed projection"
        ? { demo: { source: "path", installPath: pluginDir } }
        : undefined;
    const initial = await refresh({ reason: "manual", installRecords });
    if (missing === "installed projection") {
      await write({ ...initial, plugins: [] });
    } else {
      const nextPluginDir = path.join(stateDir, "plugins", "next-demo");
      fs.mkdirSync(nextPluginDir, { recursive: true });
      candidates.push(createCandidate(nextPluginDir, { id: "next-demo" }));
    }
    const refreshed = await refresh({
      reason: "policy-changed",
      installRecords,
      ...(missing === "policy target" ? disablePlugin("next-demo") : {}),
    });
    if (missing === "policy target") {
      expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toContain("next-demo");
    } else {
      expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
      expect((await read())?.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    }
  },
);
