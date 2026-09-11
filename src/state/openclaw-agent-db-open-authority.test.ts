import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as integrity from "../infra/sqlite-integrity-worker.js";
import * as agentLeases from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const roots = createTempDirTracker();
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realIntegrity = integrity.assertSqliteIntegrityInWorker;
const wrongIndex = "CREATE INDEX idx_agent_cache_expiry ON cache_entries(key)";

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  roots.cleanup();
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
  closeOpenClawAgentDatabaseByPath(pathname);
  const state = openOpenClawStateDatabase({ env: options.env });
  const leases = () => state.db.prepare("SELECT lease_id FROM agent_database_leases").all();
  return { options, pathname, state, leases };
}

function indexSql(pathname: string) {
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return database
      .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
      .get()?.sql;
  } finally {
    database.close();
  }
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
  let work: Promise<unknown> | undefined;
  expect(() => {
    work = own(
      withOpenClawAgentDatabaseAsync(options, operation, () => {
        throw refused;
      }),
    );
  }).not.toThrow();
  await expect(work).rejects.toBe(refused);
  expect(operation).not.toHaveBeenCalled();
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath(options))).toBe(false);
  expect(fs.readdirSync(root)).toEqual([]);
});

it.each(["ordinary", "integrity-shaped", "falsy", "native-failure"] as const)(
  "unwinds %s initiating refusal before repairing indexes for coalesced callers",
  async (kind) => {
    const f = fixture(true);
    if (kind === "native-failure") {
      const writer = openNodeSqliteDatabase(f.pathname);
      try {
        writer.exec(
          "PRAGMA foreign_keys=OFF; INSERT INTO memory_index_chunk_recall_metadata (chunk_id,importance) VALUES ('missing',1)",
        );
      } finally {
        writer.close();
      }
    }
    const gate = holdIntegrity(f.pathname);
    const refused = kind === "falsy" ? 0 : new Error("initiating authority retired");
    if (kind === "integrity-shaped" && refused instanceof Error) {
      refused.name = "SqliteIntegrityError";
    }
    let allowed = true;
    const operation = vi.fn();
    const first = own(
      withOpenClawAgentDatabaseAsync(f.options, operation, () => {
        if (!allowed) {
          // oxlint-disable-next-line typescript/only-throw-error -- This fixture deliberately verifies a falsy non-Error refusal.
          throw refused;
        }
      }),
    );
    await gate.entered.promise;
    const peer = own(withOpenClawAgentDatabaseAsync(f.options, operation, () => {}));
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
      const writer = openNodeSqliteDatabase(f.pathname);
      try {
        writer.exec("DELETE FROM memory_index_chunk_recall_metadata WHERE chunk_id='missing'");
      } finally {
        writer.close();
      }
    }
    // Refusal neither quarantines the file nor lends stale authority to a fresh caller.
    await expect(
      own(
        withOpenClawAgentDatabaseAsync(
          f.options,
          () => "fresh",
          () => {},
        ),
      ),
    ).resolves.toBe("fresh");
    expect(indexSql(f.pathname)).not.toBe(wrongIndex);
  },
);

it("keeps a coalesced peer's authority and async context separate", async () => {
  const f = fixture();
  const gate = holdIntegrity(f.pathname);
  const context = new AsyncLocalStorage<string>();
  const observations: Array<{ caller: string; context: string | undefined }> = [];
  const refused = new Error("peer retired");
  let peerAllowed = true;
  const first = own(
    context.run("initiator", () =>
      withOpenClawAgentDatabaseAsync(
        f.options,
        () => context.getStore(),
        () => {
          observations.push({ caller: "initiator", context: context.getStore() });
        },
      ),
    ),
  );
  await gate.entered.promise;
  const deniedOperation = vi.fn();
  const initiallyDenied = own(
    withOpenClawAgentDatabaseAsync(f.options, deniedOperation, () => {
      throw refused;
    }),
  );
  await expect(initiallyDenied).rejects.toBe(refused);
  expect(deniedOperation).not.toHaveBeenCalled();
  const peerOperation = vi.fn();
  const peer = own(
    context.run("peer", () =>
      withOpenClawAgentDatabaseAsync(f.options, peerOperation, () => {
        observations.push({ caller: "peer", context: context.getStore() });
        if (!peerAllowed) {
          throw refused;
        }
      }),
    ),
  );
  peerAllowed = false;
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
  const f = fixture();
  const gate = holdIntegrity(f.pathname);
  const refused = new Error("caller retired at publication");
  const firstOperation = vi.fn();
  const first = own(
    withOpenClawAgentDatabaseAsync(f.options, firstOperation, () => {
      if (getOpenClawAgentDatabaseIfOpen(f.options)) {
        throw refused;
      }
    }),
  );
  await gate.entered.promise;
  const peer = own(
    withOpenClawAgentDatabaseAsync(
      f.options,
      (database) => database,
      () => {},
    ),
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
  const f = fixture();
  const gate = holdIntegrity(f.pathname);
  const first = own(withOpenClawAgentDatabaseAsync(f.options, () => "old"));
  await gate.entered.promise;
  closeOpenClawAgentDatabaseByPath(f.pathname);
  const context = new AsyncLocalStorage<string>();
  const seen: Array<string | undefined> = [];
  const refused = new Error("joining caller retired");
  let allowed = true;
  const operation = vi.fn();
  const joining = own(
    context.run("joining", () =>
      withOpenClawAgentDatabaseAsync(f.options, operation, () => {
        seen.push(context.getStore());
        if (!allowed) {
          throw refused;
        }
      }),
    ),
  );
  allowed = false;
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
  const f = fixture(true);
  const gate = holdIntegrity(f.pathname);
  const refused = new Error("authority retired before cleanup");
  let allowed = true;
  const work = own(
    withOpenClawAgentDatabaseAsync(
      f.options,
      () => "forbidden",
      () => {
        if (!allowed) {
          throw refused;
        }
      },
    ),
  );
  await gate.entered.promise;
  f.state.db.exec(
    "CREATE TEMP TRIGGER fail_authority_release BEFORE DELETE ON agent_database_leases BEGIN SELECT RAISE(ABORT, 'retained cleanup failure'); END",
  );
  try {
    allowed = false;
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

it("checks lost database ownership before consulting the initiating caller again", async () => {
  const f = fixture();
  const gate = holdIntegrity(f.pathname);
  let ownerRetired = false;
  const forbiddenRead = vi.fn();
  const work = own(
    withOpenClawAgentDatabaseAsync(
      f.options,
      () => "forbidden",
      () => {
        if (ownerRetired) {
          forbiddenRead();
          throw new Error("caller consulted after owner retirement");
        }
      },
    ),
  );
  await gate.entered.promise;
  ownerRetired = true;
  closeOpenClawAgentDatabaseByPath(f.pathname);
  gate.release.resolve();
  await expect(work).rejects.toThrow(/revoked/);
  expect(forbiddenRead).not.toHaveBeenCalled();
  expect(gate.joined()).toBe(true);
  expect(f.leases()).toEqual([]);
});

it.each([false, true])(
  "keeps warm operation denial local without another native check (incognito=%s)",
  async (incognito) => {
    const f = fixture();
    const options = incognito
      ? {
          ...f.options,
          path: resolveIncognitoOpenClawAgentSqlitePath(f.options),
        }
      : f.options;
    const database = openOpenClawAgentDatabase(options);
    const check = vi.spyOn(integrity, "assertSqliteIntegrityInWorker");
    const refused = new Error("warm caller retired");
    let allowed = true;
    const work = own(
      withOpenClawAgentDatabaseAsync(
        options,
        () => "forbidden",
        () => {
          if (!allowed) {
            throw refused;
          }
        },
      ),
    );
    allowed = false;
    await expect(work).rejects.toBe(refused);
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(database);
    expect(database.db.isOpen).toBe(true);
    expect(check).not.toHaveBeenCalled();
  },
);

it("does not treat a database-owner failure as a repairable integrity verdict", async () => {
  const f = fixture(true);
  const gate = holdIntegrity(f.pathname);
  const failedOwner = new Error("shared database owner could not be checked");
  failedOwner.name = "SqliteIntegrityError";
  let ownerFailed = false;
  const callerRead = vi.fn();
  const work = own(
    withOpenClawAgentDatabaseAsync(
      f.options,
      () => "forbidden",
      () => {
        if (ownerFailed) {
          callerRead();
        }
      },
    ),
  );
  await gate.entered.promise;
  ownerFailed = true;
  vi.spyOn(agentLeases, "assertOpenClawAgentDatabaseLease").mockImplementation(() => {
    throw failedOwner;
  });
  gate.release.resolve();
  await expect(work).rejects.toBe(failedOwner);
  expect(callerRead).not.toHaveBeenCalled();
  expect(indexSql(f.pathname)).toBe(wrongIndex);
  expect(f.leases()).toEqual([]);
});
