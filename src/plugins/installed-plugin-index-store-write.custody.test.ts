import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import {
  refreshPersistedInstalledPluginIndex as refreshIndex,
  writePersistedInstalledPluginIndex as writeIndex,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync as readIndex } from "./installed-plugin-index-store.js";
import {
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "./plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation as refreshConfig } from "./registry-refresh.js";
import { createInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

const dirs = useStateDatabaseTempDirs();

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
    const write = (installRecords: typeof latestRecords | Record<string, never>) =>
      writeIndex(createInstalledPluginIndex({ installRecords, plugins: [] }), { env });
    let refreshing: Promise<unknown> | undefined;
    try {
      await withPluginLifecycleLease({ env }, async () => {
        await write({});
        refreshing = runOutsidePluginLifecycleLease(async () =>
          entry === "manual"
            ? refreshIndex({ env, reason: "manual", candidates: [] })
            : refreshConfig({
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
        await write(latestRecords);
      });
      await refreshing;
      expect(warn).not.toHaveBeenCalled();
      expect(readIndex({ env })).toMatchObject({
        installRecords: latestRecords,
        refreshReason: entry === "manual" ? "manual" : "source-changed",
      });
    } finally {
      await refreshing;
    }
  },
);
