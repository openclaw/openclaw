import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
import { OpenClawStateLeaseAcquisitionError } from "./openclaw-state-lease-error.js";
import * as leaseStorage from "./openclaw-state-lease-storage.js";
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
  "admits %s work after slow database preparation",
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
      await operation;
      expect(run).toHaveBeenCalledOnce();
      expect(physicalOpen).toHaveBeenCalled();
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT * FROM state_leases")
          .all(),
      ).toEqual([]);
    });
  },
);

it("records unavailable storage when a lifecycle writer prevents observing a held lease", async () => {
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
    const run = vi.fn(async () => undefined);
    try {
      await expect(
        withOpenClawStateLease(
          {
            scope: identity.scope,
            key: identity.key,
            database: { scope: "shared", options: { env: state.env } },
            leaseMs: 60_000,
            waitMs: 5_000,
            prepareDatabase: true,
          },
          run,
        ),
      ).rejects.toMatchObject({
        code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
        outcome: { kind: "store-unavailable", reason: "lifecycle-busy" },
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      writer.release();
    }
    expect(
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
        .get(identity.scope, identity.key),
    ).toMatchObject({ owner: identity.owner });
  });
});

it("does not enter maintenance after cancellation during storage preparation", async () => {
  await withOpenClawTestState({ label: "lease-aborted-preparation" }, async (state) => {
    const controller = new AbortController();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const open = stateDatabaseOpen.openUnpublishedStateDatabase;
    vi.spyOn(stateDatabaseOpen, "openUnpublishedStateDatabase").mockImplementation((options) => {
      const database = open(options);
      clock.mockReturnValue(2_500);
      controller.abort(new Error("cancel preparation"));
      clock.mockReturnValue(9_000);
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
    ).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_ABORTED",
      outcome: { kind: "aborted", reason: "caller-signal", elapsedMs: 1_500 },
      cause: controller.signal.reason,
    });
    expect(run).not.toHaveBeenCalled();
    expect(
      openOpenClawStateDatabase({ env: state.env }).db.prepare("SELECT * FROM state_leases").all(),
    ).toEqual([]);
  });
});

it.each(["acquired", "held", "store-unavailable"] as const)(
  "records cancellation while awaiting an acquisition that settles as %s",
  async (outcome) => {
    await withOpenClawTestState({ label: "lease-aborted-after-grant" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      const identity = { scope: "core:test", key: "aborted-after-grant", owner: "other-owner" };
      if (outcome === "held") {
        runOpenClawStateWriteTransaction(
          ({ db }) => leaseStore.acquireOpenClawStateLeaseInTransaction(db, identity, 60_000),
          { env: state.env },
        );
      }
      const writer = outcome === "store-unavailable" ? new DatabaseSync(database.path) : undefined;
      writer?.exec("BEGIN IMMEDIATE");
      const controller = new AbortController();
      const acquire = leaseStorage.acquireLease;
      vi.spyOn(leaseStorage, "acquireLease").mockImplementation(async (...args) => {
        try {
          const result = await acquire(...args);
          expect(result.kind).toBe(outcome);
          return result;
        } catch (error) {
          expect(outcome).toBe("store-unavailable");
          expect(error).toMatchObject({ cause: { errcode: 5 } });
          throw error;
        } finally {
          // The caller ends before the awaiting lease owner consumes the worker's result.
          controller.abort(new Error("cancel pending acquisition"));
        }
      });
      const run = vi.fn(async () => undefined);
      try {
        const failure = await withOpenClawStateLease(
          {
            scope: identity.scope,
            key: identity.key,
            database: { scope: "shared", options: { env: state.env } },
            leaseMs: 60_000,
            waitMs: 0,
            signal: controller.signal,
          },
          run,
        ).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: "OPENCLAW_STATE_LEASE_ABORTED",
          cause: controller.signal.reason,
        });
        if (outcome === "acquired") {
          expect(failure).not.toBeInstanceOf(OpenClawStateLeaseAcquisitionError);
        } else {
          expect(failure).toMatchObject({
            outcome: { kind: "aborted", reason: "caller-signal", elapsedMs: expect.any(Number) },
          });
        }
        expect(run).not.toHaveBeenCalled();
        expect(database.db.prepare("SELECT owner FROM state_leases").all()).toEqual(
          outcome === "held" ? [{ owner: identity.owner }] : [],
        );
      } finally {
        writer?.exec("ROLLBACK");
        writer?.close();
      }
    });
  },
);

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
    const sleep = vi.spyOn(backoff, "sleepWithAbort");
    try {
      await expect(
        withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
          lease.assertOwned();
        }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
        outcome: { kind: "store-unavailable", reason: "lifecycle-busy" },
      });
      expect(preparedBusyTimeoutMs).toBe(0);
      expect(sleep).not.toHaveBeenCalled();
      writer?.release();
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
        ...(reason === "aborted"
          ? { outcome: { kind: "aborted", reason: "caller-signal", elapsedMs: expect.any(Number) } }
          : {}),
      });
      expect(fs.existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
    });
  },
);
