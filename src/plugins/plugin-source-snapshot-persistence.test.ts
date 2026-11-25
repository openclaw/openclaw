import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { selectInstallMutationWriteOptions } from "./install-config-mutation.js";
import { persistPluginInstall } from "./install-persistence.js";
import { readCurrentInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { updatePluginSnapshotCandidates } from "./installed-plugin-snapshot-candidates.js";
import { withPluginLifecycleLeaseAsync } from "./plugin-lifecycle-lease.js";
import {
  PLUGIN_SOURCE_SNAPSHOT_PREFIX,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

afterEach(() => closeDefaultRetainedNativeWorkerSource());

it.each(["canonical", "reordered"] as const)(
  "persists install digests without publishing snapshots on same-version reinstall (%s)",
  async (recordOrder) => {
    await withOpenClawTestState(
      { label: "snapshot-real-install", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        await state.writeConfig({ plugins: { enabled: false } });
        const packageName = "@example/snapshot-install";
        const pluginId = "snapshot-install";
        const rootDir = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName,
          pluginId,
          version: "1.0.0",
        });
        const entry = path.join(rootDir, "dist", "index.js");
        const marker = state.path("executed");
        const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.value = 42;\n`;
        fs.writeFileSync(entry, source);
        const install = async () => {
          const prepared = await readConfigFileSnapshotForWrite();
          await persistPluginInstall({
            pluginId,
            env: state.env,
            install:
              recordOrder === "reordered"
                ? {
                    version: "1.0.0",
                    installPath: rootDir,
                    integrity: "  sha512-synthetic  ",
                    spec: `${packageName}@1.0.0`,
                    source: "npm",
                  }
                : {
                    source: "npm",
                    spec: `${packageName}@1.0.0`,
                    installPath: rootDir,
                    version: "1.0.0",
                  },
            snapshot: {
              config: prepared.snapshot.sourceConfig,
              baseHash: prepared.snapshot.hash,
              writeOptions: selectInstallMutationWriteOptions(prepared.writeOptions),
            },
            enable: false,
            runtime: { log() {} },
          });
          const index = await readCurrentInstalledPluginIndex({ env: state.env });
          const record = index?.installRecords[pluginId];
          expect(
            index?.plugins.find((plugin) => plugin.pluginId === pluginId)?.sourceSnapshot,
          ).toBeUndefined();
          const digests = record?.sourceSnapshotDigests?.[pluginId];
          expect(record?.version).toBe("1.0.0");
          expect(record?.integrity).toBe(
            recordOrder === "reordered" ? "sha512-synthetic" : undefined,
          );
          expect(digests).toEqual({
            contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            dependencyClosureDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          });
          const captureRoot = resolvePluginSourceCapturesDirectory(state.stateDir);
          expect(
            fs.existsSync(captureRoot)
              ? fs
                  .readdirSync(captureRoot)
                  .filter((name) => name.startsWith(PLUGIN_SOURCE_SNAPSHOT_PREFIX))
              : [],
          ).toEqual([]);
          expect(fs.existsSync(marker)).toBe(false);
          expect(
            await withPluginLifecycleLeaseAsync({ env: state.env }, (lease) =>
              updatePluginSnapshotCandidates({
                stateDir: state.stateDir,
                lease,
                operation: "read",
              }),
            ),
          ).toEqual([]);
          return digests;
        };
        const first = await install();
        const second = await install();
        expect(second).toEqual(first);
      },
    );
  },
);
