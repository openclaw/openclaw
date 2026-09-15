import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as backoff from "../infra/backoff.js";
import { readSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import * as stateDatabaseOpen from "./openclaw-state-db-open.js";
import { CONTENT_VERSION_KEY } from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  registerOpenClawStateDatabaseLifecycleListener,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import * as leaseStore from "./openclaw-state-lease-store.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

function controlElapsedTime() {
  const now = performance.now.bind(performance);
  let elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + elapsedMs);
  return (milliseconds: number) => {
    elapsedMs += milliseconds;
  };
}

it.each(["maintenance", "generic"] as const)(
  "preserves the %s admission contract after a slow physical database open",
  async (caller) => {
    await withOpenClawTestState({ label: "lease-cold-admission" }, async (state) => {
      const advance = controlElapsedTime();
      const open = stateDatabaseOpen.openUnpublishedStateDatabase;
      const physicalOpen = vi
        .spyOn(stateDatabaseOpen, "openUnpublishedStateDatabase")
        .mockImplementation((options) => {
          const database = open(options);
          // Keep initialization and ownership real; only its elapsed cost is simulated.
          advance(6_000);
          return database;
        });
      const run = vi.fn(async (lease: OpenClawStateLeaseContext) => lease.assertOwned());
      const operation =
        caller === "maintenance"
          ? withAgentDatabaseMaintenanceLease({ env: state.env }, run)
          : withOpenClawStateLease(
              {
                scope: "core:test",
                key: "cold-admission",
                database: { scope: "shared", options: { env: state.env } },
                leaseMs: 60_000,
                waitMs: 5_000,
              },
              run,
            );
      if (caller === "maintenance") {
        await operation;
        expect(run).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_TIMEOUT" });
        expect(run).not.toHaveBeenCalled();
      }
      expect(physicalOpen).toHaveBeenCalled();
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT * FROM state_leases")
          .all(),
      ).toEqual([]);
    });
  },
);

it("releases a late successful acquisition after maintenance storage preparation", async () => {
  await withOpenClawTestState({ label: "lease-late-acquisition" }, async (state) => {
    const advance = controlElapsedTime();
    const acquire = leaseStore.acquireOpenClawStateLeaseInTransaction;
    vi.spyOn(leaseStore, "acquireOpenClawStateLeaseInTransaction").mockImplementation(
      (database, identity, leaseMs) => {
        const expiresAt = acquire(database, identity, leaseMs);
        advance(6_000);
        return expiresAt;
      },
    );
    const run = vi.fn(async () => undefined);
    await expect(withAgentDatabaseMaintenanceLease({ env: state.env }, run)).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_TIMEOUT",
    });
    expect(run).not.toHaveBeenCalled();
    expect(
      openOpenClawStateDatabase({ env: state.env }).db.prepare("SELECT * FROM state_leases").all(),
    ).toEqual([]);
  });
});

it("keeps one wait budget when cold preparation first encounters a competing writer", async () => {
  await withOpenClawTestState({ label: "lease-preparation-contention" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const identity = { scope: "core:test", key: "preparation-contention", owner: "other-process" };
    runOpenClawStateWriteTransaction(
      ({ db }) => leaseStore.acquireOpenClawStateLeaseInTransaction(db, identity, 60_000),
      { env: state.env },
    );
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath: database.path,
      runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    });
    closeOpenClawStateDatabaseForTest();
    const writer = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs: 0 });
    if (!writer) {
      throw new Error("independent writer did not acquire its coordinator");
    }
    const advance = controlElapsedTime();
    let waitedMs = 0;
    const sleep = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (delayMs) => {
      const elapsedMs = waitedMs === 0 ? 4_000 : delayMs;
      waitedMs += elapsedMs;
      advance(elapsedMs);
      writer.release();
    });
    const controller = new AbortController();
    const run = vi.fn(async () => undefined);
    const operation = withOpenClawStateLease(
      {
        scope: identity.scope,
        key: identity.key,
        database: { scope: "shared", options: { env: state.env } },
        leaseMs: 60_000,
        waitMs: 5_000,
        prepareDatabase: true,
        signal: controller.signal,
      },
      run,
    );
    try {
      await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_TIMEOUT" });
      expect(sleep).toHaveBeenCalled();
      expect(waitedMs).toBeLessThanOrEqual(5_000);
      expect(run).not.toHaveBeenCalled();
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
          .get(identity.scope, identity.key),
      ).toMatchObject({ owner: identity.owner });
    } finally {
      writer.release();
      controller.abort();
      await operation.catch(() => undefined);
    }
  });
});

it("does not enter maintenance after cancellation during storage preparation", async () => {
  await withOpenClawTestState({ label: "lease-aborted-preparation" }, async (state) => {
    const controller = new AbortController();
    const open = stateDatabaseOpen.openUnpublishedStateDatabase;
    vi.spyOn(stateDatabaseOpen, "openUnpublishedStateDatabase").mockImplementation((options) => {
      const database = open(options);
      controller.abort(new Error("cancel preparation"));
      return database;
    });
    const run = vi.fn(async () => undefined);
    await expect(
      withOpenClawStateLease(
        {
          scope: "core:test",
          key: "aborted-preparation",
          database: { scope: "shared", options: { env: state.env } },
          leaseMs: 60_000,
          waitMs: 5_000,
          prepareDatabase: true,
          signal: controller.signal,
        },
        run,
      ),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    expect(run).not.toHaveBeenCalled();
    expect(
      openOpenClawStateDatabase({ env: state.env }).db.prepare("SELECT * FROM state_leases").all(),
    ).toEqual([]);
  });
});

it("restores the cached connection timeout after preparation fails during schema publication", async () => {
  await withOpenClawTestState({ label: "lease-preparation-restoration" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    database.db
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(CONTENT_VERSION_KEY, String(OPENCLAW_STATE_SCHEMA_VERSION), Date.now());
    database.db.exec(`
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
      UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}
      WHERE meta_key = 'primary';
    `);
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath: database.path,
      runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    });
    closeOpenClawStateDatabaseForTest();
    let writer: ReturnType<typeof tryAcquireExclusiveSqliteCoordinator> | undefined;
    let preparedBusyTimeoutMs: number | undefined;
    const unregister = registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind === "opened" && event.database.path === database.path) {
        preparedBusyTimeoutMs = readSqliteBusyTimeout(event.database.db);
        writer = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs: 0 });
        if (!writer) {
          throw new Error("independent writer did not acquire its coordinator");
        }
      }
    });
    const sleep = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      writer?.release();
    });
    try {
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
        lease.assertOwned();
      });
      expect(preparedBusyTimeoutMs).toBe(0);
      expect(sleep).toHaveBeenCalled();
      expect(readSqliteBusyTimeout(openOpenClawStateDatabase({ env: state.env }).db)).toBe(
        OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      );
    } finally {
      unregister();
      writer?.release();
    }
  });
});

it.each(["invalid", "aborted"] as const)(
  "rejects %s admission before preparing storage",
  async (reason) => {
    await withOpenClawTestState({ label: "lease-refused-preparation" }, async (state) => {
      const controller = new AbortController();
      if (reason === "aborted") {
        controller.abort();
      }
      await expect(
        withOpenClawStateLease(
          {
            scope: "core:test",
            key: "refused-preparation",
            database: { scope: "shared", options: { env: state.env } },
            leaseMs: reason === "invalid" ? 0 : 60_000,
            waitMs: 5_000,
            prepareDatabase: true,
            signal: controller.signal,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        code:
          reason === "invalid"
            ? "OPENCLAW_STATE_LEASE_INVALID_INPUT"
            : "OPENCLAW_STATE_LEASE_ABORTED",
      });
      expect(fs.existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
    });
  },
);
