import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import * as pidIdentity from "../shared/pid-alive.js";
import * as nodeSqlite from "./node-sqlite.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore as createStore } from "./update-managed-service-handoff-lease.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";

const scratch: string[] = [];
const databases: DatabaseSync[] = [];
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  for (const root of scratch.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const unix = process.platform === "win32" ? it.skip : it;
const action = {
  kind: "triage",
  phase: "reserved",
  lifetime: {
    kind: "native",
    unit: "openclaw-gateway.service",
    scope: "openclaw-triage-test.scope",
    placement: { kind: "pending" },
  },
} as const;
type Store = ReturnType<typeof createStore>;
const legacyPayload = (pid = process.pid) =>
  JSON.stringify({ version: 1, pid, startIdentity: "0" });
const leaseRows = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all();
const update = { kind: "update" } as const;
const foreground = (store: Store) =>
  ({
    kind: "triage",
    phase: "reserved",
    lifetime: { kind: "foreground", boot: store.bootIdentity() },
  }) as const;

function database(file: string) {
  const db = new DatabaseSync(file);
  databases.push(db);
  return db;
}

const observeDatabase = (visit: (db: DatabaseSync, readOnly: boolean) => void) =>
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = openDatabase(...args);
    visit(db, args[1]?.readOnly === true);
    return db;
  });

function insertLegacy(db: DatabaseSync, to: string, payload: string, replace = false) {
  db.prepare(
    `INSERT${replace ? " OR REPLACE" : ""} INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(to, "legacy-owner", payload, 1);
}

async function withChild(
  use: (child: ReturnType<typeof spawn>, exited: ReturnType<typeof once>) => Promise<void> | void,
  script = "process.stdin.resume()",
  ipc = false,
) {
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ipc ? ["pipe", "ignore", "inherit", "ipc"] : ["pipe", "ignore", "ignore"],
  });
  const exited = once(child, "exit");
  try {
    await use(child, exited);
  } finally {
    child.kill();
    await exited;
  }
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
    encoding: "utf8",
  });
  expect(child.status).toBe(0);
  const pid = Number(child.stdout.trim());
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

function expectOccupied(
  store: Store,
  source: ManagedHandoffLease,
  to: string,
  lease: ManagedHandoffLease,
) {
  const busy = { kind: "busy", owner: lease.owner };
  expect(store.acquire(to, "contender", update)).toEqual(busy);
  expect(store.retarget(source, to, action)).toEqual(busy);
  expect(store.read(to)).toEqual({ kind: "current", lease });
}

function expectLegacyRefused(store: Store, source: ManagedHandoffLease, to: string) {
  expect(() => store.acquire(to, "fresh-owner", update)).toThrow("incompatible");
  expect(() => store.retarget(source, to, action)).toThrow("incompatible");
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retarget-")));
  scratch.push(root);
  stageManagedHandoffRuntime(root);
  const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
  const from = path.join(root, "package"),
    to = path.join(root, "checkout");
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  const options = {
    databasePath: path.join(root, "lease", "state.sqlite"),
    serviceManagerEnv: resolveServiceManagerEnv(),
  };
  const store = createStore(options);
  const acquired = store.acquire(from, "original-helper", update);
  assert(acquired.kind === "acquired", "fixture busy");
  const stagedOptions = {
    ...options,
    existingIdentity: captureManagedUpdateLeaseDatabaseIdentity(options.databasePath),
  };
  // Exercise the transaction's observation window using real owner operations.
  const racing = (beforeBegin: () => void) => {
    let pending: (() => void) | undefined = beforeBegin;
    observeDatabase((db) => {
      const exec = db.exec.bind(db);
      db.exec = (sql) => {
        if (sql === "BEGIN IMMEDIATE" && pending) {
          const operation = pending;
          pending = undefined;
          operation();
        }
        return exec(sql);
      };
    });
    return createStore(options);
  };
  const closedDestination = (
    lifetime?: Extract<ManagedHandoffLease["action"], { kind: "triage" }>["lifetime"],
    uncertain = false,
  ) => {
    // Both independent processes finish through bind/activate/complete, then exit
    // without deleting the closed row. No fabricated lease grants reclamation.
    const common = `const fs=require('node:fs'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process');
const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
const store=createManagedHandoffLeaseStore(${JSON.stringify(stagedOptions)});`;
    const executor =
      common +
      `process.once('message',lease=>{const closed=store.settle(lease,${JSON.stringify(uncertain ? "uncertain" : "closed")});if(!closed)throw new Error('complete failed');process.send(closed,()=>process.disconnect());});`;
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        common +
          `
const acquired=store.acquire(${JSON.stringify(to)},'finished-owner',{kind:'triage',phase:'reserved',lifetime:${lifetime ? JSON.stringify(lifetime) : "{kind:'foreground',boot:store.bootIdentity()}"}});
if(acquired.kind!=='acquired')throw new Error('destination busy');
const child=spawn(process.execPath,['-e',${JSON.stringify(executor)}],{stdio:['ignore','ignore','inherit','ipc']});
child.once('message',lease=>process.stdout.write(JSON.stringify(lease)));
const bound=store.bind(acquired.lease,child.pid),running=bound&&store.activate(bound);
if(!running)throw new Error('activation failed');child.send(running);
`,
      ],
      { encoding: "utf8", timeout: 10_000, env: options.serviceManagerEnv },
    );
    expect(result.status, result.stderr).toBe(0);
    const closed = JSON.parse(result.stdout) as ManagedHandoffLease;
    expect(closed.action).toMatchObject({ phase: uncertain ? "uncertain" : "closed" });
    return closed;
  };
  const legacy = (payload = legacyPayload()) => {
    const db = database(options.databasePath);
    insertLegacy(db, to, payload);
    return db;
  };
  return {
    from,
    to,
    store,
    source: acquired.lease,
    racing,
    closedDestination,
    options,
    stagedOptions,
    legacy,
  };
}

unix.each(["failed", "inactive"])(
  "retains an uncertain %s scope until systemd releases its cgroup",
  (activeState) => {
    const { to, store, source, options, closedDestination } = fixture();
    const lifetime = {
      ...action.lifetime,
      placement: { kind: "attached" as const, invocation: "a".repeat(32) },
    };
    const lease = closedDestination(lifetime, true);
    const bin = path.join(path.dirname(to), "bin");
    fs.mkdirSync(bin);
    options.serviceManagerEnv.PATH = bin + path.delimiter + options.serviceManagerEnv.PATH;
    const publishScope = (controlGroup?: string) => {
      const fields = [
        `Id=${lifetime.scope}`,
        "LoadState=loaded",
        `ActiveState=${activeState}`,
        `InvocationID=${lifetime.placement.invocation}`,
        ...(controlGroup === undefined ? [] : [`ControlGroup=${controlGroup}`]),
      ];
      fs.writeFileSync(
        path.join(bin, "systemctl"),
        `#!/bin/sh\nprintf '%s\\n' ${fields.map((field) => `'${field}'`).join(" ")}\n`,
        { mode: 0o700 },
      );
    };
    for (const controlGroup of [`/user.slice/${lifetime.scope}`, undefined]) {
      publishScope(controlGroup);
      expect(store.stopNative(lease)).toBe(false);
      expect(store.release(lease)).toBe(false);
      expectOccupied(store, source, to, lease);
    }
    publishScope("");
    expect(store.stopNative(lease)).toBe(true);
    expect(store.release(lease)).toBe(true);
    expect(store.retarget(source, to, action)?.kind).toBe("acquired");
  },
);

unix.each(["changed realpath", "closed destination", "same root"])(
  "retargets %s, preserving its helper",
  (mode) => {
    const { from, to, store, source, closedDestination } = fixture();
    if (mode === "changed realpath") {
      fs.rmdirSync(from);
      fs.symlinkSync(to, from, "dir");
    } else if (mode === "closed destination") {
      closedDestination();
    }
    const target = mode === "same root" ? from : to;
    const moved = store.retarget(source, target, action);
    assert(moved?.kind === "acquired", "retarget refused");
    if (mode !== "same root") {
      expect(store.read(from)).toEqual({ kind: "absent" });
    }
    expect(moved.lease).toMatchObject({
      key: target,
      owner: source.owner,
      helper: source.helper,
      executor: source.helper,
      action,
    });
    if (mode !== "same root") {
      expect(store.current(source)).toBe(false);
    }
    expect(store.current(moved.lease)).toBe(true);
    expect(store.read(target)).toMatchObject({ kind: "current", lease: moved.lease });
    if (mode === "same root") {
      expect(moved.lease.updatedAt).toBeGreaterThan(source.updatedAt);
    }
  },
);

unix("preserves commit errors across rollback and closes its own handle", () => {
  const { from, to, store, source, options } = fixture();
  const failure = new Error("fixture commit failed");
  let damaged: DatabaseSync | undefined;
  const opener = observeDatabase((db, readOnly) => {
    if (!readOnly) {
      damaged = db;
      const exec = db.exec.bind(db);
      db.exec = (sql) => {
        if (sql === "COMMIT") {
          throw failure;
        }
        if (sql === "ROLLBACK") {
          throw new Error("fixture rollback failed");
        }
        exec(sql);
      };
    }
  });
  expect(() => store.retarget(source, to, action)).toThrow(failure);
  expect(damaged?.isOpen).toBe(false);
  opener.mockRestore();
  expect(store.read(from)).toEqual({ kind: "current", lease: source });
  expect(store.read(to)).toEqual({ kind: "absent" });
  const independent = openDatabase(options.databasePath);
  databases.push(independent);
  expect(() =>
    store.transact(independent, () =>
      store.transact(independent, () => {
        throw failure;
      }),
    ),
  ).toThrow(failure);
  expect(independent.isOpen).toBe(true);
  expect(store.transact(independent, () => "usable")).toBe("usable");
});

unix("refuses retarget while the update executor is still a child", async () => {
  const { to, store, source } = fixture();
  await withChild((child) => {
    const bound = store.bind(source, child.pid!)!;
    expect(store.retarget(bound, to, action)).toBeNull();
    expect(store.current(bound)).toBe(true);
    expect(store.read(to)).toEqual({ kind: "absent" });
  });
});

unix.each(["closed", "legacy"])("preserves %s destination after source loss", (mode) => {
  const { to, store, source, racing, closedDestination, legacy } = fixture();
  const check = (destination: () => unknown) => {
    const before = destination();
    let current: ManagedHandoffLease | null = null;
    const other = racing(() => {
      current = store.bind(source, process.pid);
      expect(current).not.toBeNull();
    });
    expect(() => other.retarget(source, to, action)).toThrow("source changed");
    expect(destination()).toEqual(before);
    expect(store.current(current!)).toBe(true);
    expect(store.retarget(source, to, action)).toBeNull();
  };
  if (mode === "closed") {
    closedDestination();
    check(() => store.read(to));
  } else {
    const db = legacy();
    check(() => db.prepare("SELECT * FROM managed_update_handoffs WHERE install_root = ?").get(to));
  }
});

unix.each(["arrival", "generation"] as const)(
  "leaves a destination %s winner unchanged",
  (race) => {
    const { to, store, source, racing, closedDestination } = fixture();
    if (race === "generation") {
      closedDestination();
    }
    let winner: ReturnType<Store["read"]>;
    const other = racing(() => {
      expect(store.acquire(to, "winner", { kind: "update" }).kind).toBe("acquired");
      winner = store.read(to);
    });
    expect(other.retarget(source, to, action)).toEqual({ kind: "busy", owner: "winner" });
    expect(store.read(to)).toEqual(winner!);
    expect(store.current(source)).toBe(true);
  },
);

unix("preserves both roots when destination inspection fails", () => {
  const { to, store, source, options } = fixture();
  expect(store.acquire(to, "winner", { kind: "update" }).kind).toBe("acquired");
  const before = store.read(to);
  const probe = observeDatabase((db) => {
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.startsWith('select "owner"')) {
        const requireReadableRoot = (root: unknown) => {
          if (typeof root !== "string") {
            throw new Error("expected one positional installation root");
          }
          if (root === to) {
            throw new Error("destination unreadable");
          }
          return root;
        };
        const get = statement.get.bind(statement);
        statement.get = (root) => get(requireReadableRoot(root));
        const iterate = statement.iterate.bind(statement);
        statement.iterate = (root) => iterate(requireReadableRoot(root));
      }
      return statement;
    };
  });
  const other = createStore(options);
  try {
    expect(() => other.retarget(source, to, action)).toThrow("destination unreadable");
  } finally {
    probe.mockRestore();
  }
  expect(store.current(source)).toBe(true);
  expect(store.read(to)).toEqual(before);
});

// Released v1 claims are cleanup inputs only, never current runtime authority.
unix.each(["update", "foreground", "retarget"] as const)(
  "retires a dead legacy process only at %s admission",
  (admission) => {
    const { from, to, store, source, legacy } = fixture();
    const payload = legacyPayload(deadPid());
    const db = legacy(payload);
    const before = leaseRows(db);
    expect(store.read(to)).toEqual({ kind: "unreadable", error: expect.any(Error) });
    expect(leaseRows(db)).toEqual(before);
    const result =
      admission === "retarget"
        ? store.retarget(source, to, action)
        : store.acquire(to, "legacy-owner", admission === "update" ? update : foreground(store));
    expect(result?.kind).toBe("acquired");
    expect(store.read(to)).toMatchObject({ kind: "current", lease: { version: 2 } });
    // A late stable updater/helper binding must lose its expected-payload CAS.
    expect(
      db
        .prepare(
          "UPDATE managed_update_handoffs SET payload_json = ?, updated_at = ? WHERE install_root = ? AND owner = ? AND payload_json = ?",
        )
        .run(payload, 2, to, "legacy-owner", payload).changes,
    ).toBe(0);
    expect(store.read(from)).toEqual(
      admission === "retarget" ? { kind: "absent" } : { kind: "current", lease: source },
    );
  },
);

unix("reclaims a legacy reused PID without granting authority to its live process", () => {
  const { to, store, legacy } = fixture();
  legacy();
  expect(store.acquire(to, "fresh-owner", { kind: "update" }).kind).toBe("acquired");
  expect(() => process.kill(process.pid, 0)).not.toThrow();
});

unix.each([
  ["live", {}],
  ["missing identity", { startIdentity: null }],
  ["malformed identity", { startIdentity: "not-a-creation-identity" }],
  ["invalid PID", { pid: -1, startIdentity: "0" }],
  ["extra authority", { startIdentity: "0", action: update }],
  ["non-object", null],
] as const)("preserves the complete %s legacy row", (_, overrides) => {
  const { to, store, source, legacy } = fixture();
  const value = overrides ? { version: 1, ...store.processIdentity(), ...overrides } : [];
  const db = legacy(JSON.stringify(value));
  const before = leaseRows(db);
  expectLegacyRefused(store, source, to);
  expect(leaseRows(db)).toEqual(before);
});

unix.each(["owner", "payload_json", "updated_at"] as const)(
  "preserves a legacy %s replacement between death probe and commit",
  (column) => {
    const { to, store, source, options, racing } = fixture();
    const db = database(options.databasePath);
    const payload = legacyPayload();
    const live = JSON.stringify({ version: 1, ...store.processIdentity() });
    const rows = () => leaseRows(db);
    for (const admission of ["acquire", "retarget"]) {
      insertLegacy(db, to, payload, true);
      let winner: ReturnType<typeof rows> = [];
      const other = racing(() => {
        db.prepare(`UPDATE managed_update_handoffs SET ${column} = ? WHERE install_root = ?`).run(
          column === "owner" ? "rebound-owner" : column === "payload_json" ? live : 2,
          to,
        );
        winner = rows();
      });
      expect(() =>
        admission === "acquire"
          ? other.acquire(to, "fresh-owner", { kind: "update" })
          : other.retarget(source, to, action),
      ).toThrow("incompatible");
      expect(rows()).toEqual(winner);
    }
  },
);

unix("preserves a legacy process with unknown creation identity", async () => {
  const { to, store, source, legacy } = fixture();
  const readStart = pidIdentity.getFileLockProcessStartTime;
  await withChild((child) => {
    const identity = store.processIdentity(child.pid);
    const db = legacy(JSON.stringify({ version: 1, ...identity, startIdentity: "0" }));
    const rows = () => leaseRows(db);
    const before = rows();
    const probe = vi
      .spyOn(pidIdentity, "getFileLockProcessStartTime")
      .mockImplementation((pid, ...args) => (pid === child.pid ? null : readStart(pid, ...args)));
    try {
      expectLegacyRefused(store, source, to);
      expect(rows()).toEqual(before);
    } finally {
      probe.mockRestore();
    }
  });
});

unix("preserves live closed-v2 actors and late revocation", async () => {
  const { to, store, source, stagedOptions } = fixture();
  const acquired = store.acquire(to, "closing-owner", foreground(store));
  assert(acquired.kind === "acquired", "fixture busy");
  const runtimeEntry = path.join(path.dirname(to), "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
  const script = `
    const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
    const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
    const store=createManagedHandoffLeaseStore(${JSON.stringify(stagedOptions)});
    process.stdin.resume();
    process.once('message',lease=>{const closed=store.settle(lease, "closed");if(!closed)throw new Error('completion refused');process.send(closed,()=>process.disconnect());});
  `;
  await withChild(
    async (child, exited) => {
      const completed = new Promise<ManagedHandoffLease>((resolve) => {
        child.once("message", resolve);
      });
      const bound = store.bind(acquired.lease, child.pid!);
      const running = bound && store.activate(bound);
      assert(running, "activation refused");
      child.send(running);
      const closed = await completed;
      expect(store.settle(running, "closing")).toEqual(closed);
      expectOccupied(store, source, to, closed);
      child.stdin!.end();
      await exited;
      expect(store.release(closed)).toBe(true);
      expect(store.read(to)).toEqual({ kind: "absent" });
    },
    script,
    true,
  );
});

unix("reclaims a dead legacy process at managed admission and cleans up on cancel", async () => {
  const { startManagedServiceUpdateHandoff, cancelManagedServiceUpdateHandoff } =
    await import("./update-managed-service-handoff.js");
  const { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } =
    await import("./update-managed-service-handoff-lease.js");
  const { to } = fixture();
  const tmpDirOwner = await import("./tmp-openclaw-dir.js");
  // Keep the legacy fixture row away from concurrent config writers.
  vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    path.join(path.dirname(to), "coordinator"),
  );
  const store = createManagedHandoffLeaseStore();
  const reserved = store.acquire(to, "legacy-owner", { kind: "update" });
  expect(reserved.kind).toBe("acquired");
  const pid = deadPid();
  const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
  try {
    db.prepare("UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?").run(
      JSON.stringify({ version: 1, pid, startIdentity: "0" }),
      to,
    );
    const identity = {
      kind: "managed-update-handoff" as const,
      installRoot: to,
      handoffId: "fresh-helper",
    };
    try {
      const started = await startManagedServiceUpdateHandoff({
        root: to,
        restartDrainTimeoutMs: 300_000,
        parentPid: process.pid,
        execPath: process.execPath,
        argv1: "/unused/openclaw.mjs",
        env: { OPENCLAW_STATE_DIR: to },
        handoffId: identity.handoffId,
        meta: {},
      });
      expect(started.status).toBe("started");
      const directory = path.dirname(started.logPath);
      scratch.push(directory);
      const params = JSON.parse(fs.readFileSync(path.join(directory, "handoff.json"), "utf8")) as {
        sensitivePaths: string[];
      };
      await expect(cancelManagedServiceUpdateHandoff(identity)).resolves.toBe(
        "restored-in-process",
      );
      // Observe product terminal cleanup before fixture rescue removes the directories.
      expect(params.sensitivePaths.filter((file) => fs.existsSync(file))).toEqual([]);
      expect(
        db.prepare("SELECT * FROM managed_update_handoffs WHERE install_root = ?").get(to),
      ).toBeUndefined();
    } finally {
      await cancelManagedServiceUpdateHandoff(identity);
    }
  } finally {
    db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(to);
    db.close();
  }
});
