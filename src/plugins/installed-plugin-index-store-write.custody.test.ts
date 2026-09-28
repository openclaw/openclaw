import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import {
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndexWithLeaseSync,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import {
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "./plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { createInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each(["manual", "committed-config", "committed-config-default"] as const)(
  "%s refresh retains install records committed while waiting for plugin ownership",
  async (entry) => {
    const stateDir = dirs.make("plugin-index-refresh-custody-");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false } }));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const queued = createDeferredCore();
    const acquire = leaseAcquisition.acquireOpenClawStateLease;
    vi.spyOn(leaseAcquisition, "acquireOpenClawStateLease").mockImplementation((params) =>
      acquire({
        ...params,
        acquire: async (...args) => {
          const outcome = await params.acquire(...args);
          if (params.label.includes("plugin lifecycle lease") && outcome.kind === "held") {
            queued.resolve();
          }
          return outcome;
        },
      }),
    );
    const latestRecords = {
      installed: {
        source: "path" as const,
        sourcePath: path.join(stateDir, "installed"),
        installPath: path.join(stateDir, "installed"),
        version: "2.0.0",
      },
    };
    const warn = vi.fn();
    let refreshing: Promise<unknown> | undefined;
    try {
      await withPluginLifecycleLease({ env }, async (lease) => {
        writePersistedInstalledPluginIndexWithLeaseSync(
          createInstalledPluginIndex({ installRecords: {}, plugins: [] }),
          { env, lease },
        );
        refreshing = runOutsidePluginLifecycleLease(async () =>
          entry === "manual"
            ? refreshPersistedInstalledPluginIndex({ env, reason: "manual", candidates: [] })
            : refreshPluginRegistryAfterConfigMutation({
                env,
                configPath,
                reason: "source-changed",
                ...(entry === "committed-config" ? { installRecords: {} } : {}),
                invalidateRuntimeCache: false,
                logger: { warn },
              }),
        );
        expect(
          await Promise.race([
            queued.promise.then(() => "held"),
            refreshing.then(() => "committed"),
          ]),
        ).toBe("held");
        writePersistedInstalledPluginIndexWithLeaseSync(
          createInstalledPluginIndex({ installRecords: latestRecords, plugins: [] }),
          { env, lease },
        );
      });
      await refreshing;
      expect(warn).not.toHaveBeenCalled();
      expect(readPersistedInstalledPluginIndexSync({ env })).toMatchObject({
        installRecords: latestRecords,
        refreshReason: entry === "manual" ? "manual" : "source-changed",
      });
    } finally {
      await refreshing;
    }
  },
);
