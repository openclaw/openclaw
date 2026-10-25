import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import {
  installDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { closePostgresPool } from "../infra/postgres-sync/pool.js";
import { installGatewayDatabaseEngine } from "./server-database-engine.js";

const observed = vi.hoisted(() => ({ workers: [] as Worker[] }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        observed.workers.push(this);
      }
    },
  };
});

afterEach(async () => {
  await closePostgresPool();
  resetDatabaseEngineSelectionForTest();
  observed.workers.length = 0;
});

it.each(["supplied", "installed"] as const)(
  "prelaunches PostgreSQL services before returning from %s Gateway selection",
  async (source) => {
    const selection: DatabaseEngineSelection = {
      effectiveEngines: {
        ...resolveDatabaseFamilyEngines({}),
        state: "postgres",
      },
      postgres: { connection: "postgresql://[invalid", schemaPrefix: "unused" },
    };
    if (source === "installed") {
      installDatabaseEngineSelection(selection);
    }
    await installGatewayDatabaseEngine(undefined, source === "supplied" ? selection : undefined);
    expect(observed.workers).toHaveLength(4);
    await installGatewayDatabaseEngine();
    expect(observed.workers).toHaveLength(4);
  },
);

it("does not launch PostgreSQL services for a SQLite Gateway", async () => {
  await installGatewayDatabaseEngine(undefined, {
    effectiveEngines: resolveDatabaseFamilyEngines({}),
  });
  expect(observed.workers).toHaveLength(0);
});
