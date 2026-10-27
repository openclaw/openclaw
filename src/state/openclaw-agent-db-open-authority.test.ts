import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import * as integrity from "../infra/sqlite-integrity-worker.js";
import * as agentLeases from "./openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-lifecycle.js";
import { useAgentDatabaseDirectories } from "./openclaw-agent-db-lifecycle.test-support.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realIntegrity = integrity.assertSqliteIntegrityInWorker;
const wrongIndex = "CREATE INDEX idx_agent_cache_expiry ON cache_entries(key)";

const roots = useAgentDatabaseDirectories(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
});

function own<T>(work: Promise<T>): Promise<T> {
  pending.push(work);
  void work.catch(() => {});
  return work;
}

function fixture(repair = false) {
  const root = roots.make("agent-open-authority-");
  const options = { agentId: "synthetic", env: { OPENCLAW_STATE_DIR: root } };
  const database = openOpenClawAgentDatabase(options);
  if (repair) {
    database.db.exec(`DROP INDEX idx_agent_cache_expiry; ${wrongIndex};`);
  }
  const pathname = database.path;
  closeOpenClawAgentDatabasesForTest(root);
  revokeSqliteDatabaseAdmissionsForPath(pathname);
  const state = openOpenClawStateDatabase({ env: options.env });
  const leases = () => state.db.prepare("SELECT lease_id FROM agent_database_leases").all();
  const run = <T>(
    operation: Parameters<typeof withOpenClawAgentDatabaseAsync<T>>[1],
    guard?: () => void,
  ) => own(withOpenClawAgentDatabaseAsync(options, operation, guard));
  return { options, pathname, state, leases, run, gate: holdIntegrity(pathname) };
}

function authority(message: string, observe: () => void = () => {}) {
  const refused = new Error(message);
  let allowed = true;
  return {
    refused,
    retire: () => {
      allowed = false;
    },
    guard: () => {
      observe();
      if (!allowed) {
        throw refused;
      }
    },
  };
}

function withNative<T>(
  pathname: string,
  run: (db: ReturnType<typeof openNodeSqliteDatabase>) => T,
  readOnly = false,
) {
  using database = openNodeSqliteDatabase(pathname, { readOnly });

  return run(database);
}

function indexSql(pathname: string) {
  return withNative(
    pathname,
    (db) =>
      db.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'").get()?.sql,
    true,
  );
}

function holdIntegrity(pathname: string) {
  const entered = createDeferred();
  const release = createDeferred();
  releases.push(() => release.resolve());
  let joined = false;
  let calls = 0;
  vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
    if (args[0] !== pathname) {
      return await realIntegrity(...args);
    }
    calls += 1;
    const result = realIntegrity(...args)
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        joined = true;
      });
    entered.resolve();
    const outcome = await result;
    await release.promise;
    if (!outcome.ok) {
      throw outcome.error;
    }
  });
  return { entered, release, joined: () => joined, calls: () => calls };
}

it("rejects already-retired authority without creating database state", async () => {
  const root = roots.make("agent-open-refused-");
  const options = { agentId: "refused", env: { OPENCLAW_STATE_DIR: root } };
  const refused = new Error("authority already retired");
  const operation = vi.fn();
  const work = own(
    withOpenClawAgentDatabaseAsync(options, operation, () => {
      throw refused;
    }),
  );
  await expect(work).rejects.toBe(refused);
  expect(operation).not.toHaveBeenCalled();
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath(options))).toBe(false);
  expect(fs.readdirSync(root)).toEqual([]);
});

it.each(["integrity-shaped", "falsy", "native-failure"] as const)(
  "unwinds %s initiating refusal before repairing indexes for coalesced callers",
  async (kind) => {
    const { gate, ...f } = fixture(true);
    if (kind === "native-failure") {
      withNative(f.pathname, (db) =>
        db.exec(
          "PRAGMA foreign_keys=OFF; INSERT INTO memory_index_chunk_recall_metadata (chunk_id,importance) VALUES ('missing',1)",
        ),
      );
    }
    const refused = kind === "falsy" ? 0 : new Error("initiating authority retired");
    if (kind === "integrity-shaped" && refused instanceof Error) {
      refused.name = "SqliteIntegrityError";
    }
    let allowed = true;
    const operation = vi.fn();
    const first = f.run(operation, () => {
      if (!allowed) {
        // oxlint-disable-next-line typescript/only-throw-error -- This fixture deliberately verifies a falsy non-Error refusal.
        throw refused;
      }
    });
    await gate.entered.promise;
    const peer = f.run(operation, () => {});
    allowed = false;
    gate.release.resolve();
    await expect(first).rejects.toBe(refused);
    await expect(peer).rejects.toBe(refused);
    expect(gate.calls()).toBe(1);
    expect(gate.joined()).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    expect(indexSql(f.pathname)).toBe(wrongIndex);
    expect(f.leases()).toEqual([]);
    expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBeUndefined();
    if (kind === "native-failure") {
      withNative(f.pathname, (db) =>
        db.exec("DELETE FROM memory_index_chunk_recall_metadata WHERE chunk_id='missing'"),
      );
    }
    // Refusal neither quarantines the file nor lends stale authority to a fresh caller.
    await expect(
      f.run(
        () => "fresh",
        () => {},
      ),
    ).resolves.toBe("fresh");
    expect(indexSql(f.pathname)).not.toBe(wrongIndex);
  },
);

it("keeps a coalesced peer's authority and async context separate", async () => {
  const { gate, ...f } = fixture();
  const context = new AsyncLocalStorage<string>();
  const observations: Array<{ caller: string; context: string | undefined }> = [];
  const { guard, retire, refused } = authority("peer retired", () => {
    observations.push({ caller: "peer", context: context.getStore() });
  });
  const first = context.run("initiator", () =>
    f.run(
      () => context.getStore(),
      () => {
        observations.push({ caller: "initiator", context: context.getStore() });
      },
    ),
  );
  await gate.entered.promise;
  const deniedOperation = vi.fn();
  const initiallyDenied = f.run(deniedOperation, () => {
    throw refused;
  });
  await expect(initiallyDenied).rejects.toBe(refused);
  expect(deniedOperation).not.toHaveBeenCalled();
  const peerOperation = vi.fn();
  const peer = context.run("peer", () => f.run(peerOperation, guard));
  retire();
  gate.release.resolve();
  await expect(first).resolves.toBe("initiator");
  await expect(peer).rejects.toBe(refused);
  expect(peerOperation).not.toHaveBeenCalled();
  expect(gate.calls()).toBe(1);
  expect(observations.some((row) => row.caller === "peer")).toBe(true);
  expect(observations.every((row) => row.caller === row.context)).toBe(true);
  expect(getOpenClawAgentDatabaseIfOpen(f.options)?.db.isOpen).toBe(true);
});

it("denies an initiating operation after publication without retiring its valid peer or handle", async () => {
  const { gate, ...f } = fixture();
  const refused = new Error("caller retired at publication");
  const firstOperation = vi.fn();
  const first = f.run(firstOperation, () => {
    if (getOpenClawAgentDatabaseIfOpen(f.options)) {
      throw refused;
    }
  });
  await gate.entered.promise;
  const peer = f.run(
    (database) => database,
    () => {},
  );
  gate.release.resolve();
  await expect(first).rejects.toBe(refused);
  const database = await peer;
  expect(firstOperation).not.toHaveBeenCalled();
  expect(database).toBe(getOpenClawAgentDatabaseIfOpen(f.options));
  expect(database.db.isOpen).toBe(true);
  expect(gate.calls()).toBe(1);
});

it("keeps the joining caller's guard across an aborted predecessor retry", async () => {
  const { gate, ...f } = fixture();
  const first = f.run(() => "old");
  await gate.entered.promise;
  closeOpenClawAgentDatabaseByPath(f.pathname);
  const context = new AsyncLocalStorage<string>();
  const seen: Array<string | undefined> = [];
  const { guard, retire, refused } = authority("joining caller retired", () => {
    seen.push(context.getStore());
  });
  const operation = vi.fn();
  const joining = context.run("joining", () => f.run(operation, guard));
  retire();
  gate.release.resolve();
  await expect(first).rejects.toThrow(/revoked/);
  await expect(joining).rejects.toBe(refused);
  expect(gate.calls()).toBe(1);
  expect(operation).not.toHaveBeenCalled();
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.every((value) => value === "joining")).toBe(true);
  expect(f.leases()).toEqual([]);
});

it("retains both authority refusal and recoverable lease cleanup failure", async () => {
  const { gate, ...f } = fixture(true);
  const { guard, retire, refused } = authority("authority retired before cleanup");
  const work = f.run(() => "forbidden", guard);
  await gate.entered.promise;
  f.state.db.exec(
    "CREATE TEMP TRIGGER fail_authority_release BEFORE DELETE ON agent_database_leases BEGIN SELECT RAISE(ABORT, 'retained cleanup failure'); END",
  );
  try {
    retire();
    gate.release.resolve();
    const failure = await work.catch((error: unknown) => error);
    assert(failure instanceof AggregateError);
    expect(failure.errors).toContain(refused);
    expect(failure.errors.some((error) => String(error).includes("retained cleanup failure"))).toBe(
      true,
    );
    expect(gate.joined()).toBe(true);
    expect(indexSql(f.pathname)).toBe(wrongIndex);
    expect(f.leases()).toHaveLength(1);
  } finally {
    f.state.db.exec("DROP TRIGGER fail_authority_release");
  }
  await closeOpenClawAgentDatabasesAsync();
  expect(f.leases()).toEqual([]);
});

it.each(["revoked", "integrity-shaped failure"] as const)(
  "checks database-owner %s before consulting the initiating caller",
  async (kind) => {
    const { gate, ...f } = fixture(kind === "integrity-shaped failure");
    const failedOwner = new Error("shared database owner could not be checked");
    failedOwner.name = "SqliteIntegrityError";
    let ownerRetired = false;
    const callerRead = vi.fn();
    const work = f.run(
      () => "forbidden",
      () => {
        if (ownerRetired) {
          callerRead();
          if (kind === "revoked") {
            throw new Error("caller consulted after owner retirement");
          }
        }
      },
    );
    await gate.entered.promise;
    ownerRetired = true;
    if (kind === "revoked") {
      closeOpenClawAgentDatabaseByPath(f.pathname);
    } else {
      vi.spyOn(agentLeases, "assertOpenClawAgentDatabaseLease").mockImplementation(() => {
        throw failedOwner;
      });
    }
    gate.release.resolve();
    if (kind === "revoked") {
      await expect(work).rejects.toThrow(/revoked/);
      expect(gate.joined()).toBe(true);
    } else {
      await expect(work).rejects.toBe(failedOwner);
      expect(indexSql(f.pathname)).toBe(wrongIndex);
    }
    expect(callerRead).not.toHaveBeenCalled();
    expect(f.leases()).toEqual([]);
  },
);

it("revokes pending native writes before draining retained resources in its root", async () => {
  const { gate: native, ...f } = fixture();
  const resourceDrain = createDeferred();
  releases.push(() => resourceDrain.resolve());
  registerOpenClawAgentDatabaseAsyncResource({
    agentId: f.options.agentId,
    path: f.pathname,
    revoke: () => {},
    close: () => resourceDrain.promise,
  });
  const write = f.run(({ db }) => {
    db.prepare(
      "INSERT INTO cache_entries (scope,key,value_json,updated_at) VALUES ('close-order','write','unexpected',1)",
    ).run();
    return "written";
  });
  await native.entered.promise;
  let closed = false;
  const closing = own(
    closeOpenClawAgentDatabasesAsync(f.options.env.OPENCLAW_STATE_DIR).then(() => {
      closed = true;
    }),
  );
  try {
    expect(f.leases()).toHaveLength(1);
    native.release.resolve();
    await expect(write).rejects.toThrow(/revoked/);
    expect(native.joined()).toBe(true);
    expect(f.leases()).toEqual([]);
    expect(closed).toBe(false);
  } finally {
    native.release.resolve();
    resourceDrain.resolve();
    await closing;
  }
  expect(closed).toBe(true);
  expect(
    withNative(
      f.pathname,
      (db) => db.prepare("SELECT key FROM cache_entries WHERE scope='close-order'").all(),
      true,
    ),
  ).toEqual([]);
});
