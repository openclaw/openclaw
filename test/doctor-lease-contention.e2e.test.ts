import assert from "node:assert/strict";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { acquireGatewayLock } from "../src/infra/gateway-lock.js";
import { runPostSessionPluginDoctorStateRepairs } from "../src/infra/state-migrations.plugin-doctor.js";
import type { listPluginDoctorStateMigrationEntries } from "../src/plugins/doctor-contract-registry.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "../src/state/openclaw-agent-db-lease.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../src/state/openclaw-state-db.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const controls = vi.hoisted(() => ({
  entries: [] as ReturnType<typeof listPluginDoctorStateMigrationEntries>,
}));

vi.mock("../src/plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugins/doctor-contract-registry.js")>()),
  listPluginDoctorStateMigrationEntries: () => controls.entries,
}));

afterEach(() => {
  controls.entries = [];
});

// Opt-in release proof: the reporter's 61.748 s of real SQLite lock occupancy
// must span the production 60 s lease while its independent worker keeps time.
it.runIf(process.env.OPENCLAW_DOCTOR_LEASE_CONTENTION_PROOF === "1")(
  "Doctor repairs after nine main-thread transactions outlive the maintenance lease",
  async () => {
    await withOpenClawTestState({ label: "doctor-lease-contention" }, async (state) => {
      const durations = [6_392, 8_648, 6_980, 5_296, 3_889, 5_700, 7_325, 9_312, 8_206];
      const blocker = new Int32Array(new SharedArrayBuffer(4));
      let initialExpiry = 0;
      let finalExpiry = 0;
      controls.entries = [
        {
          pluginId: "contention-proof",
          channelIds: [],
          trustedForDurableStores: false,
          migration: {
            id: "repair-session-state",
            label: "Contended plugin session repair",
            phase: "after-session-repair",
            detectLegacyState: () => ({ preview: ["repair synthetic plugin session state"] }),
            migrateLegacyState: () => {
              expect(isMainThread).toBe(true);
              const { db } = openOpenClawStateDatabase({ env: state.env });
              const { scope, key } = AGENT_DATABASE_MAINTENANCE_LEASE;
              const readLease = () => {
                const row = db
                  .prepare("SELECT expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
                  .get(scope, key);
                assert(row, "Maintenance lease disappeared during repair");
                return Number(row.expires_at);
              };
              initialExpiry = readLease();
              for (const [index, duration] of durations.entries()) {
                runOpenClawStateWriteTransaction(
                  () => Atomics.wait(blocker, 0, 0, duration),
                  { env: state.env },
                  { operationLabel: "agent.database.maintenance.admission" },
                );
                finalExpiry = readLease();
                if (index < durations.length - 1) {
                  // Keep the parent blocked during a known unlocked window. The
                  // 25 ms worker retry can renew; a 20 s retry misses these gaps.
                  Atomics.wait(blocker, 0, 0, 100);
                }
              }
              return { changes: ["Repaired synthetic plugin session state"], warnings: [] };
            },
          },
        },
      ];
      const lock = await acquireGatewayLock({
        env: state.env,
        role: "sqlite-maintenance",
        allowInTests: true,
      });
      assert(lock, "Doctor did not acquire isolated maintenance ownership");
      try {
        const result = await lock.run(() =>
          runPostSessionPluginDoctorStateRepairs({
            config: {},
            env: state.env,
            maintenanceAuthority: lock,
            plannedActions: [{ pluginId: "contention-proof", id: "repair-session-state" }],
          }),
        );
        expect(result).toMatchObject({
          warnings: [],
          changes: ["Repaired synthetic plugin session state"],
        });
        expect(Date.now()).toBeGreaterThan(initialExpiry);
        expect(finalExpiry).toBeGreaterThan(initialExpiry);
      } finally {
        await lock.release();
      }
    });
  },
  120_000,
);
