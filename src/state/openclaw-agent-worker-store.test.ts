import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import * as leases from "./openclaw-agent-db-lease.js";
import { withOpenClawAgentDatabaseWrite } from "./openclaw-agent-db-write.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "./openclaw-agent-db.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "./openclaw-agent-worker-store.js";
import { agentWorkerStoreFixtureEntrypoint } from "./openclaw-agent-worker-store.runtime.test-support.js";
import type { AgentWorkerFixtureOperations } from "./openclaw-agent-worker-store.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workers = new Set<OpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations>>();
let root: string;
let options: { agentId: string; path: string };
beforeEach(() => {
  root = fs.realpathSync(tempDirs.make("agent-worker-publication-"));
  options = { agentId: "main", path: path.join(root, "agent.sqlite") };
});
afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.close()));
  workers.clear();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});
async function setup(input?: { openMarker: string }) {
  const { db } = openOpenClawAgentDatabase(options);
  db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
  const worker = await openOpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations>(
    options,
    db,
    {
      moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint),
      input,
    },
  );
  workers.add(worker);
  return { db, worker };
}
async function waitForMarker(marker: string, work: Promise<unknown>) {
  const deadline = performance.now() + 5000;
  let settled = false;
  void work
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  while (!fs.existsSync(marker)) {
    if (settled) {
      await work;
      throw new Error("Worker settled before entering the fixture barrier");
    }
    if (performance.now() > deadline) {
      throw new Error("Worker did not enter the fixture barrier");
    }
    await nextTurn();
  }
}

describe("pooled agent publication owner", () => {
  it("keeps control reads responsive and admits sibling writes in FIFO order after native settlement", async () => {
    const { db, worker } = await setup();
    const transactionMarker = path.join(root, "transaction");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const native = worker.run(
      (scope) =>
        scope.execute({
          type: "append",
          input: { value: "worker", transactionMarker, delayMs: 250 },
        }),
      () => undefined,
    );
    try {
      await waitForMarker(transactionMarker, native);
      const observed: string[] = [];
      const writes = ["first", "second"].map((value) =>
        withOpenClawAgentDatabaseWrite(
          options,
          () => {
            observed.push(value);
            db.prepare("INSERT INTO worker_proof(value) VALUES (?)").run(value);
          },
          db,
        ),
      );
      expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
      await nextTurn();
      expect(observed).toEqual([]);
      expect(await native).toBeGreaterThan(0);
      await Promise.all(writes);
      expect(ticks).toBeGreaterThan(5);
      expect(observed).toEqual(["first", "second"]);
      expect(db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
        { value: "worker" },
        { value: "first" },
        { value: "second" },
      ]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      clearInterval(timer);
      await native.catch(() => undefined);
    }
  });

  it("rolls back authority revoked before commit and keeps the owner reusable", async () => {
    const { db, worker } = await setup();
    let current = true;
    const transactionMarker = path.join(root, "before-commit");
    const work = worker.run(
      (scope) => scope.execute({ type: "append", input: { value: "refused", transactionMarker } }),
      () => {
        if (!current) {
          throw new Error("fixture authority revoked");
        }
      },
    );
    void work.catch(() => undefined);
    await waitForMarker(transactionMarker, work);
    current = false;
    await expect(work).rejects.toThrow("fixture authority revoked");
    expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
    await worker.run(
      (scope) => scope.execute({ type: "append", input: { value: "retry" } }),
      () => undefined,
    );
    expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "retry" }]);
  });

  it("drains an accepted commit grant when close revokes later work", async () => {
    const { db, worker } = await setup();
    const commitMarker = path.join(root, "accepted-commit");
    const work = worker.run(
      (scope) => scope.execute({ type: "append", input: { value: "accepted", commitMarker } }),
      () => undefined,
    );
    await waitForMarker(commitMarker, work);
    let closed = false;
    const close = worker.close().then(() => {
      closed = true;
    });
    await nextTurn();
    expect(closed).toBe(false);
    await expect(
      worker.run(
        async () => 0,
        () => undefined,
      ),
    ).rejects.toThrow("closed");
    expect(await work).toBeGreaterThan(0);
    await close;
    expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "accepted" }]);
  });
  it("refuses opening before the native factory without terminating pooled siblings", async () => {
    const siblings = [];
    for (let index = 0; index < 4; index++) {
      options = { ...options, path: path.join(root, "agent-" + index + ".sqlite") };
      siblings.push(await setup());
    }
    const create = admission.createSqliteWorkerOperationAdmission;
    let refused = 0;
    const interception = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        create((request, grant) => {
          if (request.stage === "open") {
            refused++;
            throw new Error("controlled opening revocation");
          }
          admit(request, grant);
        }),
      );
    options = { ...options, path: path.join(root, "refused.sqlite") };
    const openMarker = path.join(root, "factory-entered");
    await expect(setup({ openMarker })).rejects.toThrow("controlled opening revocation");
    interception.mockRestore();
    expect(refused).toBe(1);
    expect(fs.existsSync(openMarker)).toBe(false);
    for (const { db, worker } of siblings) {
      await worker.run(
        (scope) => scope.execute({ type: "append", input: { value: "survived" } }),
        () => undefined,
      );
      expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "survived" }]);
    }
  });

  it("retains lease cleanup for a failed close and releases it on retry", async () => {
    const { worker } = await setup();
    const release = vi
      .spyOn(leases, "releaseOpenClawAgentDatabaseLease")
      .mockImplementationOnce(() => {
        throw new Error("controlled lease release failure");
      });
    await expect(worker.close()).rejects.toThrow("controlled lease release failure");
    await expect(
      worker.run(
        async () => 0,
        () => undefined,
      ),
    ).rejects.toThrow("closed");
    await worker.close();
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("queues a real periodic maintenance tick behind publication", async () => {
    let tick: (() => void) | undefined;
    let capturing = false;
    const configure = sqliteWal.configureSqliteConnectionPragmas;
    vi.spyOn(sqliteWal, "configureSqliteConnectionPragmas").mockImplementation((db, policy) => {
      capturing = policy?.databasePath === options.path;
      try {
        return configure(db, policy);
      } finally {
        capturing = false;
      }
    });
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler, milliseconds, ...args) => {
      if (capturing && typeof handler === "function") {
        tick = () => handler(...args);
      }
      return interval(handler, milliseconds, ...args);
    });
    const { db, worker } = await setup();
    if (!tick) {
      throw new Error("Expected the canonical agent maintenance timer");
    }
    const exec = vi.spyOn(db, "exec");
    const transactionMarker = path.join(root, "maintenance-transaction");
    const work = worker.run(
      (scope) =>
        scope.execute({
          type: "append",
          input: { value: "published", transactionMarker, delayMs: 250 },
        }),
      () => undefined,
    );
    await waitForMarker(transactionMarker, work);
    const started = performance.now();
    tick();
    expect(performance.now() - started).toBeLessThan(100);
    expect(exec.mock.calls.some(([sql]) => sql.includes("incremental_vacuum"))).toBe(false);
    await work;
    await withOpenClawAgentDatabaseWrite(options, () => undefined, db);
    expect(exec.mock.calls.some(([sql]) => sql.includes("incremental_vacuum"))).toBe(true);
    expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "published" }]);
  });
});
