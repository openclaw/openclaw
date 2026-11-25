import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSnapshot } from "../config/mutate.test-support.js";
import { resetConfigOverrides, setConfigOverride } from "../config/runtime-overrides.js";
import {
  installDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import {
  getGatewayResourceProfile,
  prepareGatewayResourceProfile,
  withGatewayStartupResourceProfile,
} from "../infra/gateway-resource-profile.js";
import { closePostgresPool } from "../infra/postgres-sync/pool.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { claimsSharedHostSlot } from "../infra/shared-worker-host.js";
import { installGatewayDatabaseEngine } from "./server-database-engine.js";

const observed = vi.hoisted(() => ({ workers: [] as Worker[] }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerConstructors } = await import("../../test/helpers/worker-observer.js");
  return observeWorkerConstructors(actual, observed.workers);
});

beforeEach(resetDatabaseEngineSelectionForTest);

afterEach(async () => {
  await closePostgresPool();
  resetDatabaseEngineSelectionForTest();
  resetConfigOverrides();
  observed.workers.length = 0;
});

it.each(["lean", "standard"] as const)(
  "uses each supplied %s snapshot with existing engines and runtime overrides",
  async (profile) => {
    const snapshot = createSnapshot({ sourceConfig: { gateway: { resources: { profile } } } });
    installDatabaseEngineSelection({ effectiveEngines: resolveDatabaseFamilyEngines({}) });
    await withGatewayStartupResourceProfile(async () => {
      await installGatewayDatabaseEngine(snapshot);
      expect(getGatewayResourceProfile()).toMatchObject({ profile });
      const override = profile === "lean" ? "standard" : "lean";
      setConfigOverride("gateway.resources.profile", override);
      await installGatewayDatabaseEngine(snapshot);
      expect(getGatewayResourceProfile()).toMatchObject({ profile: override });
    });
  },
);

it("keeps unresolved engines and invalid or absent startup sources conservative", async () => {
  const url = resolveRuntimeProcessEntrypointUrl("sqliteStore");
  await withGatewayStartupResourceProfile(async () => {
    prepareGatewayResourceProfile({ profile: "lean" });
    expect(claimsSharedHostSlot(url)).toBe(false);
    installDatabaseEngineSelection({ effectiveEngines: resolveDatabaseFamilyEngines({}) });
    expect(claimsSharedHostSlot(url)).toBe(true);
  });
  for (const snapshot of [
    undefined,
    {
      ...createSnapshot({
        sourceConfig: { gateway: { resources: { profile: "lean" } } },
      }),
      valid: false,
    },
  ]) {
    await withGatewayStartupResourceProfile(async () => {
      await installGatewayDatabaseEngine(snapshot);
      expect(getGatewayResourceProfile()).toBeUndefined();
      expect(claimsSharedHostSlot(url)).toBe(false);
    });
  }
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
    await withGatewayStartupResourceProfile(async () => {
      await installGatewayDatabaseEngine(
        createSnapshot({ sourceConfig: { gateway: { resources: { profile: "lean" } } } }),
        source === "supplied" ? selection : undefined,
      );
      expect(claimsSharedHostSlot(resolveRuntimeProcessEntrypointUrl("sqliteStore"))).toBe(false);
    });
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
