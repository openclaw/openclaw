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
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "./plugin-lifecycle-lease.js";
import { createInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("refreshes from the install records committed while waiting for plugin ownership", async () => {
  const stateDir = dirs.make("plugin-index-refresh-custody-");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
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
  let refreshing: Promise<InstalledPluginIndex> | undefined;
  try {
    await withPluginLifecycleLease({ env }, async (lease) => {
      writePersistedInstalledPluginIndexWithLeaseSync(
        createInstalledPluginIndex({ installRecords: {}, plugins: [] }),
        { env, lease },
      );
      refreshing = runOutsidePluginLifecycleLease(async () =>
        refreshPersistedInstalledPluginIndex({ env, reason: "manual", candidates: [] }),
      );
      expect(
        await Promise.race([queued.promise.then(() => "held"), refreshing.then(() => "committed")]),
      ).toBe("held");
      writePersistedInstalledPluginIndexWithLeaseSync(
        createInstalledPluginIndex({ installRecords: latestRecords, plugins: [] }),
        { env, lease },
      );
    });
    expect((await refreshing)?.installRecords).toEqual(latestRecords);
    expect(readPersistedInstalledPluginIndexSync({ env })?.installRecords).toEqual(latestRecords);
  } finally {
    await refreshing;
  }
});
