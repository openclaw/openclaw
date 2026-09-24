import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { getPairedDevice, listDevicePairing, listDevicePairingReadOnly } from "./device-pairing.js";
import type { PairedDevice } from "./device-pairing.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test.skipIf(process.env.OPENCLAW_DEVICE_PAIRING_BENCH !== "1")(
  "measures pairing list and lookup main-thread CPU with 5,000 devices and 50 callers",
  async () => {
    const baseDir = tempDirs.make("pairing-worker-bench-");
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
    });
    const devices: PairedDevice[] = Array.from({ length: 5_000 }, (_, index) => ({
      deviceId: `device-${index}`,
      publicKey: `synthetic-key-${index}`,
      displayName: `Synthetic device ${index}`,
      platform: "linux",
      role: "node",
      roles: ["node"],
      scopes: [],
      tokens: {
        node: { token: `synthetic-token-${index}`, role: "node", scopes: [], createdAtMs: 1 },
      },
      nodeSurface: {
        commands: ["system.run"],
        caps: ["canvas"],
        createdAtMs: 1,
        approvedAtMs: index + 1,
      },
      createdAtMs: 1,
      approvedAtMs: index + 1,
    }));
    try {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const insert = db.prepare(
            "INSERT INTO device_pairing_paired (device_id, public_key, display_name, platform, role, roles_json, scopes_json, tokens_json, node_surface_json, created_at_ms, approved_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          );
          for (const device of devices) {
            insert.run(
              device.deviceId,
              device.publicKey,
              device.displayName!,
              device.platform!,
              device.role!,
              JSON.stringify(device.roles),
              JSON.stringify(device.scopes),
              JSON.stringify(device.tokens),
              JSON.stringify(device.nodeSurface),
              device.createdAtMs,
              device.approvedAtMs,
            );
          }
        },
        { database, env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } },
      );
      const golden = JSON.stringify({ pending: [], paired: devices.toReversed() });
      for (const [name, read, expected] of [
        ["list", () => listDevicePairing(baseDir), golden],
        ["list-readonly", () => listDevicePairingReadOnly(baseDir), golden],
        ["lookup", () => getPairedDevice("device-2500", baseDir), JSON.stringify(devices[2500])],
      ] as const) {
        expect(JSON.stringify(await read())).toBe(expected);
        const rounds: Array<{ cpuMs: number; wallMs: number }> = [];
        for (let round = 0; round < 7; round++) {
          const cpu = process.threadCpuUsage();
          const started = performance.now();
          const results = await Promise.all(Array.from({ length: 50 }, () => read()));
          const usage = process.threadCpuUsage(cpu);
          const sample = {
            cpuMs: (usage.user + usage.system) / 1_000 / 50,
            wallMs: (performance.now() - started) / 50,
          };
          expect(JSON.stringify(results[49])).toBe(expected);
          if (round >= 2) {
            rounds.push(sample);
          }
        }
        const median = (key: "cpuMs" | "wallMs") =>
          rounds.map((sample) => sample[key]).toSorted((a, b) => a - b)[2];
        console.log(
          JSON.stringify({
            pairingBenchmark: name,
            devices: devices.length,
            callers: 50,
            mainThreadMs: median("cpuMs"),
            amortizedWallMs: median("wallMs"),
          }),
        );
      }
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  },
);
