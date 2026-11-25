import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeReadResources, createStateReadPool } from "../state/openclaw-state-read-pool.js";
import { initializeGatewayResourceProfile } from "./gateway-resource-profile.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  claimsSharedHostSlot,
  createHostedWorker,
  type HostedWorkerEndpoint,
} from "./shared-worker-host.js";
import { getTrackedWorkerPoolSnapshot } from "./worker-cpu.js";

// The conservative policy Bun Windows reports: closing a database does not prove release.
vi.mock("./bun-sqlite-library.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bun-sqlite-library.js")>();
  const unqualified = Object.freeze({
    explicitSqliteCloseReleasesNativeResources: false,
    decided: true,
    reason: "test: native close is not qualified",
  });
  return {
    ...actual,
    getSqliteRuntimeCapabilities: () => unqualified,
    captureSqliteWorkerClosePolicy: () => false,
  };
});

const live = new Set<HostedWorkerEndpoint>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  for (const endpoint of live) {
    endpoint.retiring("cancelled");
    await endpoint.terminate();
  }
  live.clear();
  initializeGatewayResourceProfile({ profile: "standard" });
});

function census(match: string) {
  return getTrackedWorkerPoolSnapshot().workerCensus.filter((row) => row.kind.includes(match));
}

it("never hosts a core worker when native SQLite close is unqualified", () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  for (const entrypoint of [
    "sqliteStore",
    "sessionTranscript",
    "stateRead",
    "pluginModelCatalogRead",
  ] as const) {
    expect(claimsSharedHostSlot(resolveRuntimeProcessEntrypointUrl(entrypoint))).toBe(false);
  }
});

it("rotates an unqualified reader by physical worker exit while a shared host stays up", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const root = tempDirs.make("openclaw-shared-host-unqualified-");
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "state.sqlite");
  const seed = new DatabaseSync(file);
  seed.exec(
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); INSERT INTO config_machine_state VALUES ('nodeHost.config', '1', 1)",
  );
  seed.close();
  // A live sibling keeps the physical host isolate alive across the reader's retirement.
  const sibling = createHostedWorker(
    resolveRuntimeProcessEntrypointUrl("sqliteStore"),
    {},
    { key: "sqlite-store:agent", ready: false },
  );
  live.add(sibling);
  await new Promise<void>((resolve) => {
    sibling.once("started", resolve);
  });

  const pool = createStateReadPool(resolveRuntimeProcessEntrypointUrl("stateRead"));
  try {
    await pool.run(
      {
        databasePath: file,
        location: file,
        context: { environment: { OPENCLAW_STATE_DIR: root } },
        command: { type: "nodeHost.config" },
        checkFreshAdmission: false,
      },
      {},
    );
    // The reader runs in its own isolate, not as a second endpoint of the shared host.
    expect(census("shared-worker-host")).toMatchObject([{ count: 1, hostedEndpoints: 1 }]);
    expect(census("state-read")).toMatchObject([{ count: 1 }]);

    // Unqualified close retires the reader by rotation, whose release boundary is worker exit.
    await closeReadResources(pool);
    expect(census("state-read")).toEqual([]);
    expect(sibling.executionStopped).toBe(false);
  } finally {
    await pool.close();
  }
});
