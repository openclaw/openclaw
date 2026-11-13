import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "../infra/sqlite-private-directory.js";
import { createSqliteSnapshotStagingTokenSync } from "../infra/sqlite-snapshot-staging.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { waitForMediaCleanupDrainsToSettle } from "./server-media-cleanup-lifecycle.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

// mock-isolation: This storage cleanup regression does not exercise device expiration.
vi.mock("../infra/device-bootstrap.js", () => ({ startDevicePairSetupMaintenance: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("reclaims the installation's abandoned snapshots after startup reconnects", async () => {
  const home = tempDirs.make("gateway-snapshot-maintenance-");
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
    },
    async () => {
      const root = resolvePrivateSqliteSnapshotStagingRoot();
      const orphan = createSqliteSnapshotStagingTokenSync(root);
      const payload = path.join(
        orphan.directory,
        ".fs-safe-12345678-1234-4234-8234-123456789abc.tmp",
      );
      fs.writeFileSync(payload, "synthetic abandoned copy");
      orphan.release();
      const old = new Date(Date.now() - 60 * 60_000);
      fs.utimesSync(payload, old, old);
      fs.utimesSync(orphan.directory, old, old);
      const orphans = [orphan.directory];
      const unknown: string[] = [];
      // More eligible copies than the former scan limit proves progress without
      // depending on directory enumeration order; missing tokens must stay put.
      const prefix = path.join(root, "openclaw-sqlite-readonly-v2-");
      for (let index = 0; index < 256; index++) {
        const copy = fs.mkdtempSync(prefix);
        fs.cpSync(orphan.directory, copy, { recursive: true, preserveTimestamps: true });
        fs.utimesSync(copy, old, old);
        orphans.push(copy);
        const missing = fs.mkdtempSync(prefix);
        fs.utimesSync(missing, old, old);
        unknown.push(missing);
      }
      const otherRoot = resolvePrivateSqliteSnapshotStagingRoot({
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(home, "other-state"),
      });
      const other = createSqliteSnapshotStagingTokenSync(otherRoot);
      other.release();
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const errors: string[] = [];
      const timers = startGatewayMaintenanceTimers({
        ...createGatewayMaintenanceStateForTest(),
        scheduler,
        isNixMode: true,
        logHealth: {
          info: (message) => {
            errors.push(message);
          },
          error: (message) => {
            errors.push(message);
          },
        },
      });
      try {
        await waitForMediaCleanupDrainsToSettle();
        await clock.advanceBy(120_000);
        expect(fs.existsSync(payload)).toBe(true);
        await clock.advanceBy(10_000);
        for (const directory of orphans) {
          expect(fs.existsSync(directory), errors.join("\n")).toBe(false);
        }
        expect(unknown.every((directory) => fs.existsSync(directory))).toBe(true);
        expect(fs.existsSync(other.directory)).toBe(true);
      } finally {
        await timers.stopPeriodicTasks();
        await timers.skillUsageCleanup();
        await scheduler.stop();
      }
    },
  );
});
