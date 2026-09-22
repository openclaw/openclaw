import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createWorkerEnvironmentStore } from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it.skipIf(!["1", "baseline"].includes(process.env.OPENCLAW_WORKER_INVENTORY_BENCH ?? ""))(
  "measures 5,000 environment inventory rows across 50 viewers",
  async () => {
    type BenchmarkStore = Pick<
      Awaited<ReturnType<typeof createWorkerEnvironmentStore>>,
      "list" | "listForReconcile" | "createIntent"
    >;
    type Factory = (
      options: Parameters<typeof createWorkerEnvironmentStore>[0],
    ) => BenchmarkStore | Promise<BenchmarkStore>;
    // The comparison command stages the exact original source beside its original writer.
    const baseline: { createWorkerEnvironmentStore: Factory } | undefined =
      process.env.OPENCLAW_WORKER_INVENTORY_BENCH === "baseline"
        ? await import(new URL("./store.baseline.test-support.ts", import.meta.url).href)
        : undefined;
    const createStore = baseline?.createWorkerEnvironmentStore ?? createWorkerEnvironmentStore;
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: tempDirs.make("worker-inventory-bench-") },
    });
    const store = await createStore({ database, now: () => 1_000 });
    await store.createIntent({
      environmentId: "worker-00000",
      providerId: "provider-0",
      profileId: "profile-0",
      profileSnapshot: { settings: { region: "test", machine: "medium" } },
      provisionOperationId: "provision-00000",
    });
    const template = database.db.prepare("SELECT * FROM worker_environments").get()!;
    const columns = Object.keys(template);
    const insert = database.db.prepare(
      `INSERT INTO worker_environments (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    runOpenClawStateWriteTransaction(
      () => {
        for (let index = 1; index < 5_000; index += 1) {
          const suffix = String(index).padStart(5, "0");
          const row = {
            ...template,
            environment_id: `worker-${suffix}`,
            provider_id: `provider-${index % 8}`,
            profile_id: `profile-${index % 20}`,
            provision_operation_id: `provision-${suffix}`,
            state: index % 5 === 0 ? "failed" : "requested",
            created_at_ms: index,
          };
          insert.run(...columns.map((column) => row[column as keyof typeof row]));
        }
      },
      { database },
    );
    const inventory = await createStore({ database, now: () => 1_000 });
    for (const name of ["list", "listForReconcile"] as const) {
      const expected = inventory[name]();
      expect(expected).toHaveLength(name === "list" ? 5_000 : 4_001);
      const golden = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
      expect(golden).toBe(
        name === "list"
          ? "dc8fe897b3f1531952e5dcf7ac59820fd7d442a6cd1d73fa7b62103cc5020adb"
          : "04f39389262b61ce99433d6ea9f913ac46ab80d11f90687c265135bd13eae6c9",
      );
      const samples = [];
      for (let round = 0; round < 6; round += 1) {
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        for (let viewer = 0; viewer < 50; viewer += 1) {
          inventory[name]();
        }
        const used = process.threadCpuUsage(cpu);
        if (round > 0) {
          samples.push({
            cpu: (used.user + used.system) / 1_000 / 50,
            wall: (performance.now() - started) / 50,
          });
        }
      }
      console.log(
        JSON.stringify({
          operation: name,
          rows: expected.length,
          golden,
          mainThreadMs: samples.map((s) => s.cpu).toSorted((a, b) => a - b)[2],
          wallMs: samples.map((s) => s.wall).toSorted((a, b) => a - b)[2],
        }),
      );
    }
  },
);
