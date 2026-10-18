import { isMainThread } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
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
describe.runIf(process.env.OPENCLAW_DOCTOR_LEASE_CONTENTION_PROOF === "1")(
  "Doctor plugin session repair under sustained SQLite contention",
  () => {
    it("settles after nine main-thread immediate transactions outlive the original maintenance lease", async () => {
      await withOpenClawTestState({ label: "doctor-lease-contention" }, async (state) => {
        const durations = [6_392, 8_648, 6_980, 5_296, 3_889, 5_700, 7_325, 9_312, 8_206];
        const blocker = new Int32Array(new SharedArrayBuffer(4));
        const observations: { heldMs: number; heartbeatAt: number; expiresAt: number }[] = [];
        let initialExpiry = 0;
        let repaired = false;
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
                const readLease = () => {
                  const row = db
                    .prepare(
                      "SELECT expires_at, heartbeat_at FROM state_leases WHERE scope = ? AND lease_key = ?",
                    )
                    .get(
                      AGENT_DATABASE_MAINTENANCE_LEASE.scope,
                      AGENT_DATABASE_MAINTENANCE_LEASE.key,
                    );
                  expect(row).toBeDefined();
                  return {
                    expiresAt: Number(row?.expires_at),
                    heartbeatAt: Number(row?.heartbeat_at),
                  };
                };
                initialExpiry = readLease().expiresAt;
                for (const [index, duration] of durations.entries()) {
                  const started = performance.now();
                  runOpenClawStateWriteTransaction(
                    () => Atomics.wait(blocker, 0, 0, duration),
                    { env: state.env },
                    { operationLabel: "agent.database.maintenance.admission" },
                  );
                  observations.push({ heldMs: performance.now() - started, ...readLease() });
                  if (index < durations.length - 1) {
                    // Keep the parent blocked during a known unlocked window. The
                    // 25 ms worker retry can renew; a 20 s retry misses these gaps.
                    Atomics.wait(blocker, 0, 0, 100);
                  }
                }
                repaired = true;
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
        expect(lock).not.toBeNull();
        if (!lock) {
          throw new Error("Doctor did not acquire isolated maintenance ownership");
        }
        try {
          const result = await lock.run(() =>
            runPostSessionPluginDoctorStateRepairs({
              config: {},
              env: state.env,
              maintenanceAuthority: lock,
              plannedActions: [{ pluginId: "contention-proof", id: "repair-session-state" }],
            }),
          );
          console.info(
            JSON.stringify({
              step: "plugin-doctor-post-session-state",
              initialExpiry,
              observations,
              result,
            }),
          );
          expect(result.warnings).toEqual([]);
          expect(result.changes).toEqual(["Repaired synthetic plugin session state"]);
          expect(repaired).toBe(true);
          expect(observations).toHaveLength(9);
          expect(Date.now()).toBeGreaterThan(initialExpiry);
          expect(observations.at(-1)?.expiresAt).toBeGreaterThan(initialExpiry);
        } finally {
          await lock.release();
        }
      });
    }, 120_000);
  },
);
