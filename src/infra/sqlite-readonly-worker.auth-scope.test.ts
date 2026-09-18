import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  runSqliteReadOnlyWorker,
  withSqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import {
  acquireStateDatabaseHandleExclusion,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.mocked(spawn).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const source = path.join(tempDirs.make("openclaw-auth-session-"), "agent.sqlite");
  const coordinatorRuntime = {
    directory: tempDirs.make("openclaw-auth-session-coordinator-"),
    keepAlive: false,
  };
  const write = (revision: number) => {
    const db = new (requireNodeSqlite().DatabaseSync)(source);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
        CREATE TABLE IF NOT EXISTS auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
      `);
      db.prepare("INSERT OR REPLACE INTO auth_profile_store VALUES ('primary', ?)").run(
        JSON.stringify({ version: 1, profiles: { synthetic: { key: `synthetic-${revision}` } } }),
      );
      db.prepare("INSERT OR REPLACE INTO auth_profile_state VALUES ('primary', ?)").run(
        JSON.stringify({ revision }),
      );
    } finally {
      db.close();
    }
  };
  write(1);
  const options = {
    mode: "auth-profile-rows" as const,
    expectedIdentity: readDatabasePathIdentitySync(source).key,
    env: { ...process.env },
    coordinatorRuntime,
  };
  return { source, write, options, read: () => runSqliteReadOnlyWorker(source, options) };
}

it("reuses only execution while rereading auth rows and reacquiring source admission", async () => {
  const { source, write, options, read } = fixture();
  await withSqliteReadOnlyWorkerScope(async () => {
    expect(await read()).toMatchObject({ state: { raw: { revision: 1 } } });
    write(2);
    expect(await read()).toEqual({
      store: {
        status: "readable",
        raw: { version: 1, profiles: { synthetic: { key: "synthetic-2" } } },
      },
      state: { status: "readable", raw: { revision: 2 } },
    });
    expect(spawn).toHaveBeenCalledTimes(process.versions.bun ? 2 : 1);
    const child = vi.mocked(spawn).mock.results.at(-1)?.value;
    expect(child.exitCode).toBe(process.versions.bun ? 0 : null);
    const exclusion = withStateDatabaseCoordinatorRuntimeDirectory(options.coordinatorRuntime, () =>
      acquireStateDatabaseHandleExclusion({ databasePath: source, busyTimeoutMs: 0 }),
    );
    try {
      await expect(read()).rejects.toThrow("state-handles");
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      exclusion.release();
    }
    expect(await read()).toMatchObject({ state: { raw: { revision: 2 } } });
  });
  for (const result of vi.mocked(spawn).mock.results) {
    expect(result.value.connected).toBe(false);
    expect(result.value.exitCode !== null || result.value.signalCode !== null).toBe(true);
  }
});

it("rejects a replaced source before returning rows from a warm auth child", async () => {
  const { source, write, options, read } = fixture();
  await withSqliteReadOnlyWorkerScope(async () => {
    await read();
    fs.renameSync(source, `${source}.retired`);
    write(2);
    await expect(read()).rejects.toThrow("identity changed");
    options.expectedIdentity = readDatabasePathIdentitySync(source).key;
    expect(await read()).toMatchObject({ state: { raw: { revision: 2 } } });
  });
  expect(spawn).toHaveBeenCalledTimes(process.versions.bun ? 3 : 2);
});

it("compares captured auth environments rather than ambient state", async () => {
  const { options, read } = fixture();
  await withSqliteReadOnlyWorkerScope(async () => {
    await read();
    vi.stubEnv("OPENCLAW_AUTH_SESSION_SYNTHETIC", "ambient-change");
    try {
      await read();
      expect(spawn).toHaveBeenCalledTimes(process.versions.bun ? 2 : 1);
      options.env = { ...options.env, OPENCLAW_AUTH_SESSION_SYNTHETIC: "request-change" };
      await read();
      expect(spawn).toHaveBeenCalledTimes(process.versions.bun ? 3 : 2);
      expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.OPENCLAW_AUTH_SESSION_SYNTHETIC).toBe(
        "request-change",
      );
      expect(vi.mocked(spawn).mock.results[0]?.value.exitCode).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it.skipIf(Boolean(process.versions.bun))(
  "captures the replacement launch before awaiting the preceding child close",
  async () => {
    const { options, read } = fixture();
    const originalCwd = process.cwd();
    const nextCwd = tempDirs.make("openclaw-auth-session-cwd-");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await withSqliteReadOnlyWorkerScope(async () => {
      await read();
      const child = vi.mocked(spawn).mock.results[0]?.value;
      const send = child.send.bind(child);
      vi.spyOn(child, "send").mockImplementationOnce((message: unknown, callback?: unknown) => {
        expect(message).toBe("close");
        expect(typeof callback).toBe("function");
        entered();
        void gate.then(() => send(message, callback));
        return true;
      });
      options.env = { ...options.env, OPENCLAW_AUTH_SESSION_SYNTHETIC: "captured" };
      const next = read();
      try {
        await closing;
        options.env.OPENCLAW_AUTH_SESSION_SYNTHETIC = "later";
        vi.spyOn(process, "cwd").mockReturnValue(nextCwd);
        release();
        expect(await next).toMatchObject({ state: { raw: { revision: 1 } } });
        expect(vi.mocked(spawn).mock.calls[1]?.[2]).toMatchObject({
          cwd: originalCwd,
          env: { OPENCLAW_AUTH_SESSION_SYNTHETIC: "captured" },
        });
      } finally {
        release();
        await Promise.allSettled([next]);
      }
    });
  },
);

it("keeps concurrent auth reads independent and joins cancellation before scope return", async () => {
  const { source, options, read } = fixture();
  const controller = new AbortController();
  const failure = new Error("synthetic read cancelled");
  await withSqliteReadOnlyWorkerScope(async () => {
    const rows = await Promise.all([read(), read()]);
    for (const row of rows) {
      expect(row).toMatchObject({ state: { raw: { revision: 1 } } });
    }
    expect(spawn).toHaveBeenCalledTimes(2);
    const children = vi.mocked(spawn).mock.results.map((result) => result.value);
    expect(children[0].pid).not.toBe(children[1].pid);
    const live = children.filter((child) => child.exitCode === null);
    expect(live).toHaveLength(process.versions.bun ? 0 : 1);
    expect(children.filter((child) => child.exitCode === 0)).toHaveLength(
      process.versions.bun ? 2 : 1,
    );
    controller.abort(failure);
    await expect(
      runSqliteReadOnlyWorker(source, { ...options, signal: controller.signal }),
    ).rejects.toBe(failure);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
  });
  expect(vi.mocked(spawn).mock.results.every((result) => !result.value.connected)).toBe(true);
});
