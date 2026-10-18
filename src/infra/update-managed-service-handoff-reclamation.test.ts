import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Compilable } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../test/helpers/managed-handoff-isolation.js";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as processGroups from "../process/child-process-tree.js";
import * as processIdentity from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const roots = createTempDirTracker();
const unix = process.platform === "win32" ? it.skip : it;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.cleanup();
});

function fixture() {
  const root = roots.make("handoff-reclamation-");
  const make = (name: string) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    return directory;
  };
  const install = make("install");
  const slot = path.join(root, "linked-install");
  fs.symlinkSync(install, slot, process.platform === "win32" ? "junction" : "dir");
  const privateTmp = make("private-tmp");
  const state = make("state");
  const { databasePath: handoff } = installPrivateUpdateHandoffStore(privateTmp);
  const binding = createManagedHandoffTestBinding(privateTmp);
  const childEnv = writePrivateUpdateHandoffChildGuard(handoff, privateTmp);
  const homeEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  };
  for (const [key, value] of Object.entries(homeEnv)) {
    vi.stubEnv(key, value);
  }
  const env = childEnv({ ...process.env, ...homeEnv });
  const storeOptions = { databasePath: handoff, serviceManagerEnv: env };
  const store = createManagedHandoffLeaseStore(storeOptions);
  const pair = () => [store.read(install), store.read(slot)];
  const expectAbsent = () => expect(pair()).toEqual([{ kind: "absent" }, { kind: "absent" }]);
  const child = path.join(root, "original-owner.mts");
  const executorUrl = new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href;
  const leaseUrl = new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href;
  const crash = (mode: "ordinary" | "cancelled" = "ordinary", holderPid?: number) => {
    fs.writeFileSync(
      child,
      `
import { createRequire } from "node:module";
createRequire(import.meta.url)(${JSON.stringify(path.join(privateTmp, "private-handoff-guard.cjs"))});
const { withUpdateCommandExecutor, requestUpdateCommandExecutorCancellation } = await import(${JSON.stringify(executorUrl)});
const { createManagedHandoffLeaseStore } = await import(${JSON.stringify(leaseUrl)});
const runId = ${JSON.stringify(randomUUID())};
await withUpdateCommandExecutor(runId, async (executor) => {
  const fence = await executor.enter(${JSON.stringify(slot)});
  if (${JSON.stringify(holderPid ?? null)} !== null) {
    const store = createManagedHandoffLeaseStore({databasePath:${JSON.stringify(handoff)},serviceManagerEnv:process.env});
    const current = store.read(${JSON.stringify(slot)});
    if (current.kind !== "current" || !store.bind(current.lease, ${JSON.stringify(holderPid ?? 0)})) { throw new Error("Fixture slot binding failed"); }
  }
  if (${JSON.stringify(mode)} === "cancelled") requestUpdateCommandExecutorCancellation(fence, runId, new Error("original cancellation"));
  process.kill(process.pid, "SIGKILL");
});
`,
    );
    const args = ["--import", "tsx", binding.nodeOption, child];
    const result = spawnSync(resolveTestNodeExecPath(), args, {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    expect([result.error, result.signal], result.stderr).toEqual([undefined, "SIGKILL"]);
    assertManagedHandoffTestConsumer(binding, result.pid, path.resolve("src"));
    const original = store.read(install),
      occupied = store.read(slot);
    assert(original.kind === "current" && occupied.kind === "current", "Missing crash pair");
    assert(occupied.lease.version === 2, "Unexpected occupied-slot format");
    expect(occupied.lease.mutationOriginal?.key).toBe(install);
    return { original, occupied };
  };
  const retry = () =>
    withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(slot);
      fence.assertCurrent();
      const original = store.read(install),
        occupied = store.read(slot);
      assert(original.kind === "current" && occupied.kind === "current", "Missing new pair");
      expect(original.lease.helper).toMatchObject({ pid: process.pid });
      expect(occupied.lease).toMatchObject({ owner: original.lease.owner });
      expect([original.lease, occupied.lease].map(store.current)).toEqual([true, true]);
    });
  return { install, slot, handoff, store, storeOptions, env, crash, retry, pair, expectAbsent };
}

it("preserves both old generations while the occupied slot still has a live executor", async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    env: f.env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const closed = once(holder, "close");
  try {
    await once(holder, "spawn");
    assert(holder.pid, "Missing holder pid");
    const before = f.crash("ordinary", holder.pid);
    await expect(f.retry()).rejects.toThrow("Another update executor");
    expect(f.pair()).toEqual([before.original, before.occupied]);
  } finally {
    holder.kill("SIGKILL");
    await closed;
  }
  await f.retry();
  f.expectAbsent();
});

it("does not reclaim original cancellation custody after the process dies", async () => {
  const f = fixture();
  const before = f.crash("cancelled");
  expect(before.original.lease.version).toBe(4);
  await expect(f.retry()).rejects.toThrow("Another update executor");
  expect(f.pair()).toEqual([before.original, before.occupied]);
});

it.each(["release", "releaseAll"] as const)(
  "%s preserves an original until its exact occupied generation settles",
  (method) => {
    const f = fixture();
    const store = createManagedHandoffLeaseStore({
      ...f.storeOptions,
      originalUpdateKey: f.install,
    });
    const original = store.acquire(f.install, "original", { kind: "update" });
    assert(original.kind === "acquired", "Original acquisition failed");
    const occupied = store.acquire(
      f.slot,
      "original",
      { kind: "update" },
      false,
      undefined,
      original.lease,
    );
    assert(occupied.kind === "acquired", "Occupied acquisition failed");
    const before = f.pair();
    expect(
      method === "release" ? store.release(original.lease) : store.releaseAll([original.lease]),
    ).toBe(false);
    expect(f.pair()).toEqual(before);
    expect([original.lease, occupied.lease].map(store.current)).toEqual([true, true]);
    expect(store.acquire(f.install, "contender", { kind: "update" }).kind).toBe("busy");

    const rebound = store.bind(occupied.lease, process.pid);
    assert(rebound, "Occupied rebinding failed");
    expect(store.releaseAll([original.lease, occupied.lease])).toBe(false);
    expect(store.read(f.install)).toEqual(before[0]);
    expect(store.current(rebound)).toBe(true);
    expect(store.releaseAll([original.lease, rebound])).toBe(true);
    f.expectAbsent();
    const next = store.acquire(f.install, "next", { kind: "update" });
    assert(next.kind === "acquired", "Next generation acquisition failed");
    expect(store.release(next.lease)).toBe(true);
  },
);

function retainedCommandFixture(
  options: {
    mirror?: boolean;
    orphan?: boolean;
    custody?: "reserved" | "bound";
    helper?: "dead" | "live" | "unknown";
    groupAlive?: boolean;
  } = {},
) {
  const f = fixture();
  const database = createManagedHandoffLeaseDatabase(f.handoff);
  const query = <Row>(
    write: boolean,
    build: (sql: ReturnType<typeof leaseQueries>) => Compilable<Row>,
  ) => database(write, (db) => executeSqliteQuerySync(db, build(leaseQueries(db))).rows);
  const rootIdentity = { pid: 777101, startIdentity: "1" };
  const helper = { pid: 777102, startIdentity: "2" };
  const executor = { pid: 777103, startIdentity: "3" };
  const rootLease = {
    version: 2,
    helper: rootIdentity,
    executor: rootIdentity,
    action: {
      kind: "update",
      ...(options.mirror ? { mutationProtocol: "original-cancellation-v1" } : {}),
    },
  };
  const rootPayload = JSON.stringify(rootLease);
  const original = {
    install_root: f.install,
    owner: "previous-update",
    payload_json: rootPayload,
    updated_at: 1,
  };
  const parents = options.orphan ? [] : [original];
  if (options.mirror) {
    parents.push({
      ...original,
      install_root: f.slot,
      payload_json: JSON.stringify({
        ...rootLease,
        mutationOriginal: {
          key: f.install,
          owner: original.owner,
          payload: rootPayload,
          updatedAt: original.updated_at,
        },
      }),
    });
  }
  const commandKeys = [f.install, ...(options.mirror ? [f.slot] : [])].map(
    (root) => `${root}/.openclaw-update-child-previous-doctor/.openclaw-update-child-command`,
  );
  const command = {
    owner: "previous-doctor",
    payload_json: JSON.stringify({
      version: 2,
      helper,
      executor,
      action: { kind: "update", custody: options.custody ?? "bound" },
    }),
    updated_at: 2,
  };
  query(true, (sql) =>
    sql
      .insertInto("managed_update_handoffs")
      .values([...parents, ...commandKeys.map((install_root) => ({ ...command, install_root }))]),
  );
  const isDead = processIdentity.isPidDefinitelyDead;
  const readStart = processIdentity.getFileLockProcessStartTime;
  vi.spyOn(processIdentity, "isPidDefinitelyDead").mockImplementation((pid) =>
    pid === rootIdentity.pid || pid === executor.pid
      ? true
      : pid === helper.pid
        ? !options.helper || options.helper === "dead"
        : isDead(pid),
  );
  vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((pid, env) =>
    pid === helper.pid ? (options.helper === "unknown" ? null : 2) : readStart(pid, env),
  );
  const groupAlive = processGroups.isChildProcessTreeAlive;
  vi.spyOn(processGroups, "isChildProcessTreeAlive").mockImplementation((child) =>
    child.pid === executor.pid ? (options.groupAlive ?? false) : groupAlive(child),
  );
  const rows = () =>
    query(false, (sql) =>
      sql.selectFrom("managed_update_handoffs").selectAll().orderBy("install_root"),
    );
  return { ...f, query, rows, commandKeys, helper };
}

unix.each([
  { name: "ordinary root", mirror: false, orphan: false },
  { name: "original and occupied slot", mirror: true, orphan: false },
  { name: "orphaned command namespace", mirror: false, orphan: true },
])("retires dead command claims when reopening $name", ({ mirror, orphan }) => {
  const f = retainedCommandFixture({ mirror, orphan });
  const before = f.rows();
  expect(before.some((row) => f.commandKeys.includes(row.install_root))).toBe(true);
  // Reads must not silently prune durable custody before a mutation owner admits repair.
  f.store.read(f.install);
  expect(f.rows()).toEqual(before);
  const repaired = f.store.acquire(f.install, "repair", { kind: "update" });
  assert(repaired.kind === "acquired", "Expected repaired installation admission");
  expect(f.rows().map((row) => row.install_root)).toEqual([f.install]);
  expect(f.store.release(repaired.lease)).toBe(true);
  expect(f.rows()).toEqual([]);
  const reopenedStore = createManagedHandoffLeaseStore(f.storeOptions);
  const reopened = reopenedStore.acquire(f.install, "next-update", { kind: "update" });
  assert(reopened.kind === "acquired", "Reopened installation admission failed");
  expect(reopenedStore.release(reopened.lease)).toBe(true);
});

unix.each([
  { name: "pending reservation", custody: "reserved" as const },
  { name: "live helper", helper: "live" as const },
  { name: "unverified helper", helper: "unknown" as const },
  { name: "surviving command group", groupAlive: true },
])("preserves every retained row beside a $name", (options) => {
  const f = retainedCommandFixture(options);
  const before = f.rows();
  expect(f.store.acquire(f.install, "repair", { kind: "update" }).kind).toBe("busy");
  expect(f.rows()).toEqual(before);
});

unix("refuses reclamation after a command generation changes", () => {
  const f = retainedCommandFixture();
  const rootBefore = f.store.read(f.install);
  const isDead = vi.mocked(processIdentity.isPidDefinitelyDead).getMockImplementation();
  assert(isDead, "Missing process observation fixture");
  let replaced = false;
  vi.spyOn(processIdentity, "isPidDefinitelyDead").mockImplementation((pid) => {
    if (pid === f.helper.pid && !replaced) {
      replaced = true;
      f.query(true, (sql) =>
        sql
          .updateTable("managed_update_handoffs")
          .set({ owner: "replacement-doctor", updated_at: 3 })
          .where("install_root", "=", f.commandKeys[0]!),
      );
    }
    return isDead(pid);
  });
  expect(f.store.acquire(f.install, "repair", { kind: "update" }).kind).toBe("busy");
  expect(replaced).toBe(true);
  expect(f.store.read(f.install)).toEqual(rootBefore);
  expect(f.rows().find((row) => row.install_root === f.commandKeys[0])).toMatchObject({
    owner: "replacement-doctor",
    updated_at: 3,
  });
});
