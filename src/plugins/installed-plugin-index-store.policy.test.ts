import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import {
  publishPluginSourceAdmissionInDatabase,
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
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

describe("installed plugin index policy refresh", () => {
  it("refreshes policy without rebuilding source and preserves a concurrently published admission", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = recordPluginCandidateInstallOwner(createCandidate(pluginDir), "package");
    const installRecords = {
      package: { source: "git", installPath: pluginDir },
      orphaned: { source: "path", installPath: path.join(stateDir, "missing") },
    } satisfies InstalledPluginIndex["installRecords"];
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const initial = refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      installRecords,
      env,
    });
    const admissionKey = pluginDir + "\0";
    const admission = {
      signature: "admitted-source",
      sourceDigest: "a".repeat(64),
      nativeArtifacts: {},
      nativeNamespaces: {},
    };
    const sourceAdmissions = { [admissionKey]: admission };
    const latestAdmission = { ...admission, signature: "readmitted-source" };
    await writePersistedInstalledPluginIndex(
      {
        ...initial,
        plugins: initial.plugins.map((plugin) => ({ ...plugin, sourceAdmissions })),
      },
      { stateDir },
    );
    expect(
      Object.keys((await readPersistedInstalledPluginIndex({ stateDir }))!.installRecords),
    ).toEqual(["orphaned", "package"]);
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        configSchema: { type: "object" },
        providers: ["demo", "changed"],
      }),
      "utf8",
    );

    const refreshed = refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      installRecords,
      env,
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      policyPluginIds: ["demo"],
      now: () => {
        // Admission commits after refresh reads its snapshot but before its write transaction.
        expect(
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              publishPluginSourceAdmissionInDatabase(db, {
                pluginId: "demo",
                rootDir: fs.realpathSync(pluginDir),
                installRecordHash: initial.plugins[0]?.installRecordHash,
                key: admissionKey,
                receipt: latestAdmission,
              }),
            resolveInstalledPluginIndexStateDatabaseOptions({ stateDir }),
          ),
        ).toBe(true);
        return new Date();
      },
    });

    expect(refreshed.plugins).toHaveLength(initial.plugins.length);
    expect(refreshed.plugins.find((plugin) => plugin.pluginId === "demo")).toMatchObject({
      pluginId: "demo",
      enabled: false,
      manifestHash: initial.plugins[0]?.manifestHash,
      sourceAdmissions: { [admissionKey]: latestAdmission },
    });
    expect(
      (await readPersistedInstalledPluginIndex({ stateDir }))?.plugins[0]?.sourceAdmissions,
    ).toEqual({ [admissionKey]: latestAdmission });
    expect(refreshed.policyHash).not.toBe(initial.policyHash);

    const changedInstallRecords = {
      ...installRecords,
      package: { ...installRecords.package, source: "npm" },
    } satisfies InstalledPluginIndex["installRecords"];
    const rebuilt = refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      installRecords: changedInstallRecords,
      env,
    });
    expect(rebuilt.plugins[0]?.manifestHash).not.toBe(initial.plugins[0]?.manifestHash);
    expect(rebuilt.plugins[0]?.sourceAdmissions).toBeUndefined();
  });

  it("falls back to a source rebuild when a policy refresh target is missing", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    const nextPluginDir = path.join(stateDir, "plugins", "next-demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(nextPluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const nextCandidate = createCandidate(nextPluginDir, { id: "next-demo" });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    const refreshed = refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate, nextCandidate],
      env,
      config: {
        plugins: {
          entries: {
            "next-demo": {
              enabled: false,
            },
          },
        },
      },
      policyPluginIds: ["next-demo"],
    });

    expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toContain("next-demo");
  });

  it.each(["path", "npm", "archive", "git", "clawhub", "marketplace"] as const)(
    "restores an installed %s plugin missing from a policy refresh projection",
    async (source) => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "plugins", "demo");
      fs.mkdirSync(pluginDir, { recursive: true });
      const candidate = createCandidate(pluginDir);
      const installRecords = {
        demo: { source, installPath: pluginDir },
      } satisfies InstalledPluginIndex["installRecords"];
      const env = {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      };
      const initial = refreshPersistedInstalledPluginIndex({
        reason: "manual",
        stateDir,
        candidates: [candidate],
        installRecords,
        env,
      });
      await writePersistedInstalledPluginIndex({ ...initial, plugins: [] }, { stateDir });

      const refreshed = refreshPersistedInstalledPluginIndex({
        reason: "policy-changed",
        stateDir,
        candidates: [candidate],
        installRecords,
        env,
      });

      expect(refreshed.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
      expect(
        (await readPersistedInstalledPluginIndex({ stateDir }))?.plugins.map(
          (plugin) => plugin.pluginId,
        ),
      ).toEqual(["demo"]);
    },
  );
});
