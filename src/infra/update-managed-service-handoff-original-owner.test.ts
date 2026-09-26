import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { killProcessTree } from "../process/kill-tree.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";

const roots: string[] = [];
const stops = new Set<() => Promise<void>>();
afterEach(async () => {
  await Promise.all([...stops].map((stop) => stop()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(paired = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "original-helper-")));
  roots.push(root);
  const make = (name: string) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    return directory;
  };
  const install = make("install");
  const retained = make("retained");
  const tmp = make("tmp");
  const state = make("state");
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const { databasePath } = installPrivateUpdateHandoffStore(tmp);
  const env = writePrivateUpdateHandoffChildGuard(databasePath, tmp)({ ...process.env });
  // Native generation transport checks physical files before any SQLite open.
  const stateFile = path.join(state, "openclaw.sqlite");
  fs.writeFileSync(stateFile, "", { mode: 0o600 });
  const fileIdentity = (file: string) => {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const transport = () => ({
    protocol: "initial-pair-v1" as const,
    selection: {
      privateRoot: { path: root, identity: fileIdentity(root) },
      installation: { path: install, identity: fileIdentity(install) },
      handoff: {
        databasePath,
        databaseIdentity: fileIdentity(databasePath),
        parentIdentity: fileIdentity(tmp),
      },
      state: {
        databasePath: stateFile,
        databaseIdentity: fileIdentity(stateFile),
        parentIdentity: fileIdentity(state),
      },
    },
  });
  const options = {
    databasePath,
    serviceManagerEnv: env,
    originalUpdateKey: install,
    ...(paired ? { originalUpdateRetainedKey: retained } : {}),
  };
  const initial = createManagedHandoffLeaseStore(options);
  const acquire = () => {
    const acquired = initial.acquire(install, "original-helper", { kind: "update" });
    if (acquired.kind !== "acquired" || !acquired.originalDatabaseIdentity) {
      throw new Error("Missing original acquisition");
    }
    return {
      original: acquired.lease,
      retainedLease: acquired.retainedLease,
      identity: acquired.originalDatabaseIdentity,
      store: createManagedHandoffLeaseStore({
        ...options,
        existingIdentity: acquired.originalDatabaseIdentity,
      }),
    };
  };
  const script = path.join(root, "executor.mts");
  fs.writeFileSync(
    script,
    `
const { createManagedHandoffLeaseStore } = await import(${JSON.stringify(new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href)});
const pending = new Map();
let serial = 0;
process.on("disconnect", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("control disconnected"));
  pending.clear();
});
const request = (kind, args, closed) => new Promise((resolve, reject) => {
  const id = ++serial;
  pending.set(id, { resolve, reject });
  process.send({ kind, id, args, closed });
});
process.on("message", async (input) => {
  if (input.dropControl) {
    process.disconnect();
    return;
  }
  if (input.ack) {
    const waiter = pending.get(input.ack);
    pending.delete(input.ack);
    waiter?.resolve();
    return;
  }
  const store = createManagedHandoffLeaseStore({
    databasePath: input.identity.databasePath, existingIdentity: input.identity,
    serviceManagerEnv: process.env,
  });
  if (input.holdPipe) {
    const { spawn } = await import("node:child_process");
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: process.env, stdio: ["ignore", process.stdout, "ignore"],
    });
    holder.unref();
    holder.once("spawn", () => {
      process.send({ holder: holder.pid }, () => process.exit(0));
    });
    return;
  }
  if (input.retryIssuer || input.planPair) {
    const assert = (await import("node:assert/strict")).default;
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { registerSealedRuntime } = await import(${JSON.stringify(new URL("./sealed-runtime-registry.ts", import.meta.url).href)});
    const ambient = path.join(path.dirname(input.identity.databasePath), "unselected-ambient");
    registerSealedRuntime({ json5: undefined, resolveSecureTempRoot: () => ambient });
    const meta = path.join(path.dirname(input.result), "sentinel.json");
    fs.writeFileSync(meta, JSON.stringify({version:1,meta:{
      runId:"managed-test", handoffId:input.lease.owner, root:input.lease.key,
    }}));
    process.env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
    process.env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META = meta;
    const { withUpdateCommandExecutor } = await import(${JSON.stringify(new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href)});
    if (input.planPair) {
      await withUpdateCommandExecutor("managed-test", async (executor) => {
        const fence = await executor.enter(input.lease.key, { serviceRoot: input.serviceRoot });
        fence.assertCurrent();
        fs.writeFileSync(input.effect, "pair-admitted");
      }, { initialStores: input.transport, managedGeneration: async (captured) => {
        await request("plan", [captured.retainedRoot], false);
        return {
          assertCurrent: () => assert.ok(process.connected),
          retire: () => { throw new Error("Unexpected publication"); },
          select: () => { throw new Error("Unexpected selection"); },
          terminal: (current) => request("terminal", [current], false),
          revoke: () => request("revoke", [], true),
        };
      }});
      assert.equal(fs.existsSync(ambient), false);
      fs.writeFileSync(input.result, "planned-pair-settled");
      process.disconnect();
      return;
    }
    let attempts = 0;
    const missingPair = input.retryIssuer === "missing-pair";
    const plan = { serviceRoot: missingPair ? input.serviceRoot : undefined };
    const executorOptions = { initialStores: input.transport, managedGeneration: async () => {
      attempts++;
      if (!missingPair) {
        executorOptions.managedGeneration = undefined;
        await Promise.resolve();
        throw new Error("issuer refused");
      }
      return {
        assertCurrent: () => assert.ok(process.connected),
        retire: () => { throw new Error("Unexpected publication"); },
        select: () => { throw new Error("Unexpected selection"); },
        terminal: () => { throw new Error("Unexpected terminal"); },
        revoke: () => request("revoke", [], true),
      };
    }};
    await assert.rejects(withUpdateCommandExecutor("managed-test", async (executor) => {
      await assert.rejects(executor.enter(input.lease.key), /service-root plan is missing/);
      await assert.rejects(executor.enter(input.serviceRoot, { serviceRoot: undefined }), /effective installation or store selectors diverged/);
      assert.equal(store.read(input.serviceRoot).kind, "absent");
      await assert.rejects(executor.enter(input.lease.key, plan), missingPair ? /retained pair changed/ : /issuer refused/);
      await assert.rejects(executor.enter(input.lease.key, plan), /admission is incomplete/);
    }, executorOptions), /ownership is no longer current/);
    assert.equal(attempts, 1);
    assert.equal(fs.existsSync(ambient), false);
    fs.writeFileSync(input.result, "retry-refused");
    process.disconnect();
    return;
  }
  if (input.slot) {
    const acquired = store.acquire(input.slot, "occupied-slot", { kind: "update" },
      false, undefined, input.lease);
    if (acquired.kind !== "acquired") throw new Error("Slot admission refused");
    const descendant = store.acquire(input.slot + "/.openclaw-update-child-slot",
      "slot-descendant", { kind: "update", mutationProtocol: "original-cancellation-v1" });
    if (descendant.kind !== "acquired") throw new Error("Slot descendant refused");
    process.send({ slot: acquired.lease, descendant: descendant.lease }, () => process.disconnect());
    return;
  }
  if (input.orphan) {
    const acquired = store.acquire(input.lease.key + "/.openclaw-update-child-orphan",
      "orphan", { kind: "update", mutationProtocol: "original-cancellation-v1" });
    if (acquired.kind !== "acquired") throw new Error("Orphan admission refused");
    process.send({ orphan: acquired.lease }, () => process.disconnect());
    return;
  }
  if (input.mode) {
    const assert = (await import("node:assert/strict")).default;
    const fs = await import("node:fs");
    const { admitManagedUpdateCommandGeneration, finishManagedUpdateCommandGeneration, completeManagedUpdateCommandOutcome } = await import(${JSON.stringify(new URL("../cli/update-cli/update-command-executor-managed.ts", import.meta.url).href)});
    let closed = false;
    const managed = await admitManagedUpdateCommandGeneration({
      input: { runId: "managed-test", lease: input.lease, retainedRoot: null, database: input.identity, initialStores: input.transport },
      assertNative: () => assert.ok(store.acceptParentBoundExecutor(input.lease)),
      closeEffects: () => { closed = true; },
      issuer: async (captured) => {
        assert.deepEqual(captured.lease, input.lease);
        return {
          assertCurrent: () => assert.ok(process.connected),
          retire: (...args) => request("retire", args, closed),
          select: (...args) => request("select", args, closed),
          terminal: (...args) => request("terminal", args, closed),
          revoke: () => request("revoke", [], closed),
        };
      },
    });
    if (input.mode === "terminal-race") {
      const cause = new Error("terminal cancellation");
      const finishing = finishManagedUpdateCommandGeneration(
        managed, { result: "success" }, input.transport, () => {});
      // Register ahead of the awaiting teardown continuation: cancellation is
      // accepted after terminal's last check but before synchronous sealing.
      void finishing.then(() => managed.requestCancellation(cause)).catch(() => {});
      const outcome = await completeManagedUpdateCommandOutcome(managed, await finishing);
      assert.equal(outcome.error, cause);
      fs.writeFileSync(input.result, "terminal-revoke-joined");
    } else if (input.mode === "success") {
      await managed.beforeRetire("transition", input.transport);
      fs.writeFileSync(input.effect, "after-retire-ack");
      await managed.select("transition", input.transport);
      await assert.rejects(managed.select("transition", input.transport), /retired transition/);
      await managed.terminal(input.transport);
      fs.writeFileSync(input.result, "terminal-acked");
    } else {
      const cause = new Error("stop effects now");
      const revoked = managed.requestCancellation(cause);
      assert.equal(closed, true);
      assert.throws(() => managed.assertCurrent(), error => error === cause);
      if (input.mode === "disconnect") {
        await assert.rejects(revoked, /control disconnected/);
        fs.writeFileSync(input.result, "revoke-not-acknowledged");
      } else {
        await revoked;
        const { CommandProcessCleanupError, hasCommandProcessCleanupError } = await import(${JSON.stringify(new URL("../process/exec-result.ts", import.meta.url).href)});
        const cleanup = new CommandProcessCleanupError();
        const outcome = await completeManagedUpdateCommandOutcome(
          managed, { error: new AggregateError([cause, cleanup], "join failed") });
        assert.ok(hasCommandProcessCleanupError(outcome.error));
        fs.writeFileSync(input.result, "revoke-committed");
      }
    }
    if (process.connected) process.disconnect();
    return;
  }
  process.send({
    admitted: store.acceptParentBoundExecutor(input.lease),
    retained: !input.retainedLease || store.acceptParentBoundExecutor(input.retainedLease),
    refused: store.cancelUpdate(input.lease) === null,
  });
});
process.send({ ready: true, pid: process.pid, ppid: process.ppid });
`,
  );
  const spawn = async () => {
    const child = fork(script, [], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      execArgv: ["--import", "tsx"],
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    child.stdout?.resume();
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    // Capture error without turning an IPC failure into a fabricated close.
    let error: Error | undefined;
    child.on("error", (cause) => {
      error = cause;
    });
    const join = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Executor close remains unjoined")), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const stop = async () => {
      const termination = child.pid
        ? killProcessTree(child.pid, {
            detached: process.platform !== "win32",
            graceMs: 1_000,
          })
        : undefined;
      if (termination) {
        await delay(1_000);
        termination.force();
      }
      await join();
      stops.delete(stop);
    };
    stops.add(stop);
    try {
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
      expect(ready).toEqual({ ready: true, pid: child.pid, ppid: process.pid });
    } catch (cause) {
      await stop();
      throw cause;
    }
    return {
      child,
      get closed() {
        return join();
      },
      stop,
      async observe(
        lease: ManagedHandoffLease,
        retainedLease: ManagedHandoffLease | undefined,
        identity: ReturnType<typeof acquire>["identity"],
      ) {
        const message = once(child, "message", { signal: AbortSignal.timeout(10_000) });
        child.send({ lease, retainedLease, identity });
        expect((await message)[0]).toEqual({ admitted: true, retained: true, refused: true });
        expect(error).toBeUndefined();
      },
    };
  };
  return { root, install, retained, initial, acquire, spawn, transport };
}

it("atomically admits the selected helper pair and rolls back a busy second root", () => {
  const f = fixture(true);
  const busy = f.initial.acquire(f.retained, "other-owner", { kind: "update" });
  expect(busy.kind).toBe("acquired");
  expect(f.initial.acquire(f.install, "original-helper", { kind: "update" })).toEqual({
    kind: "busy",
    owner: "other-owner",
  });
  expect(f.initial.read(f.install).kind).toBe("absent");
  if (busy.kind !== "acquired") {
    throw new Error("Missing busy root");
  }
  expect(f.initial.release(busy.lease)).toBe(true);
  const { original, retainedLease, store } = f.acquire();
  expect(retainedLease?.helper).toEqual(original.helper);
  expect(store.releaseOriginalUpdate(structuredClone(original), original)).toBe(false);
  expect(store.releaseOriginalUpdate(original, original)).toBe(true);
  expect(store.read(f.install).kind).toBe("absent");
  expect(store.read(f.retained).kind).toBe("absent");
});

it("revokes the bound pair only with the unchanged original receipt and releases after child close", async () => {
  const f = fixture(true);
  const { original, retainedLease, identity, store } = f.acquire();
  const c = await f.spawn();
  let cancelled: ReturnType<typeof store.cancelUpdate> = null;
  try {
    const bound = store.bindOriginalUpdateExecutor(original, original, c.child);
    expect(bound).not.toBeNull();
    if (!bound) {
      throw new Error("Missing child binding");
    }
    await c.observe(bound.lease, bound.retainedLease, identity);
    const serviceChild = store.acquire(
      f.retained + "/.openclaw-update-child-service",
      "service-child",
      { kind: "update", mutationProtocol: "original-cancellation-v1" },
    );
    expect(serviceChild.kind).toBe("acquired");
    expect(store.selectOriginalUpdateRetainedRoot(original, bound.lease, f.retained)).toBeNull();
    if (serviceChild.kind !== "acquired") {
      throw new Error("Missing retained-root descendant");
    }
    expect(store.release(serviceChild.lease)).toBe(true);
    expect(
      store.selectOriginalUpdateRetainedRoot(original, bound.lease, f.retained),
    ).not.toBeNull();
    expect(store.cancelUpdate(structuredClone(original))).toBeNull();
    expect(store.cancelUpdate(bound.lease)).toBeNull();
    expect(store.cancelUpdate(structuredClone(bound.lease))).toBeNull();
    expect(store.cancelUpdate(original, { ...retainedLease!, owner: "foreign" })).toBeNull();
    expect(store.returnOriginalUpdateExecutor(original, bound.lease)).toBeNull();
    expect(store.releaseOriginalUpdate(original, bound.lease)).toBe(false);
    cancelled = store.cancelUpdate(original);
    expect(cancelled).not.toBeNull();
    expect(store.current(bound.lease)).toBe(false);
    expect(store.current(bound.retainedLease!)).toBe(false);
    expect(cancelled?.release()).toBe(false);
    expect(store.returnOriginalUpdateExecutor(original, bound.lease)).toBeNull();
  } finally {
    await c.stop();
  }
  expect(cancelled?.release()).toBe(true);
  expect(store.read(f.install).kind).toBe("absent");
  expect(store.read(f.retained).kind).toBe("absent");
}, 30_000);

it("returns the exact joined pair to its helper and permits a later terminal child", async () => {
  const f = fixture(true);
  const { original, store } = f.acquire();
  let current = original;
  for (let index = 0; index < 2; index++) {
    const c = await f.spawn();
    try {
      const bound = store.bindOriginalUpdateExecutor(original, current, c.child);
      expect(bound).not.toBeNull();
      if (!bound) {
        throw new Error("Missing bound pair");
      }
      current = bound.lease;
      expect(store.returnOriginalUpdateExecutor(structuredClone(original), current)).toBeNull();
      expect(store.returnOriginalUpdateExecutor(original, current)).toBeNull();
    } finally {
      await c.stop();
    }
    const returned = store.returnOriginalUpdateExecutor(original, current);
    expect(returned?.lease.executor).toEqual(original.helper);
    expect(returned?.retainedLease?.executor).toEqual(original.helper);
    current = returned!.lease;
  }
  expect(store.releaseOriginalUpdate(original, current)).toBe(true);
  expect(store.read(f.install).kind).toBe("absent");
  expect(store.read(f.retained).kind).toBe("absent");
}, 30_000);

it("refuses receipt advancement through generic binding or caller-mutated acquisition", async () => {
  const f = fixture();
  const { original, store } = f.acquire();
  const c = await f.spawn();
  let bound: ManagedHandoffLease | null = null;
  try {
    expect(store.bind(original, c.child.pid!, { kind: "update" })).toBeNull();
    expect(store.current(original)).toBe(true);
    bound = store.bind(original, c.child.pid!);
    expect(bound).not.toBeNull();
    expect(store.bindOriginalUpdateExecutor(original, bound!, c.child)).toBeNull();
    expect(store.cancelUpdate(original)).toBeNull();
    original.owner = "changed";
    expect(store.bindOriginalUpdateExecutor(original, bound!, c.child)).toBeNull();
    expect(store.cancelUpdate(original)).toBeNull();
  } finally {
    await c.stop();
    expect(store.bind(bound!, process.pid)).toBeNull();
    expect(store.release(bound!)).toBe(false);
  }
}, 30_000);

it("keeps cancellation custody while a descendant row remains unsettled", async () => {
  const f = fixture();
  const { original, store } = f.acquire();
  const c = await f.spawn();
  let bound: ReturnType<typeof store.bindOriginalUpdateExecutor> = null;
  let descendant: ManagedHandoffLease | undefined;
  try {
    bound = store.bindOriginalUpdateExecutor(original, original, c.child);
    expect(bound).not.toBeNull();
    const child = store.acquire(f.install + "/.openclaw-update-child-test", "descendant", {
      kind: "update",
      mutationProtocol: "original-cancellation-v1",
    });
    if (child.kind !== "acquired") {
      throw new Error("Missing descendant");
    }
    descendant = child.lease;
  } finally {
    await c.stop();
  }
  expect(store.returnOriginalUpdateExecutor(original, bound!.lease)).toBeNull();
  const cancelled = store.cancelUpdate(original);
  expect(cancelled).not.toBeNull();
  expect(cancelled?.release()).toBe(false);
  expect(store.release(descendant!)).toBe(true);
  expect(cancelled?.release()).toBe(true);
}, 30_000);

it("refuses copied original/current rows and replacement physical databases", async () => {
  const f = fixture();
  const { original, store } = f.acquire();
  const c = await f.spawn();
  const database = path.join(f.root, "tmp", "managed-update-handoffs.sqlite");
  const saved = database + ".saved";
  try {
    expect(
      store.bindOriginalUpdateExecutor(structuredClone(original), original, c.child),
    ).toBeNull();
    expect(
      store.bindOriginalUpdateExecutor(original, { ...original, owner: "foreign" }, c.child),
    ).toBeNull();
    fs.renameSync(database, saved);
    fs.copyFileSync(saved, database);
    expect(() => store.bindOriginalUpdateExecutor(original, original, c.child)).toThrow(/identity/);
    expect(() => store.cancelUpdate(original)).toThrow(/identity/);
  } finally {
    await c.stop();
    fs.rmSync(database);
    fs.renameSync(saved, database);
    expect(store.release(original)).toBe(true);
  }
}, 30_000);

it("does not advance either original generation when the retained pair changed", async () => {
  const f = fixture(true);
  const { original, retainedLease, store } = f.acquire();
  const c = await f.spawn();
  let replacement: ManagedHandoffLease | null = null;
  try {
    replacement = store.bind(retainedLease!, c.child.pid!);
    expect(replacement).not.toBeNull();
    expect(store.bindOriginalUpdateExecutor(original, original, c.child)).toBeNull();
    expect(store.current(original)).toBe(true);
    expect(store.current(replacement!)).toBe(true);
  } finally {
    await c.stop();
  }
  // Generic binding lost its receipt; it must retain rather than release either row.
  expect(store.releaseAll([original, replacement!])).toBe(false);
  expect(store.current(original)).toBe(true);
}, 30_000);

it.each(["success", "revoke", "disconnect", "terminal-race"] as const)(
  "keeps managed producer ACK and child settlement separate: %s",
  async (mode) => {
    const f = fixture();
    const { original, identity, store } = f.acquire();
    const c = await f.spawn();
    const effect = path.join(f.root, "effect");
    const result = path.join(f.root, "result");
    const initialStores = f.transport();
    let bound: ReturnType<typeof store.bindOriginalUpdateExecutor> = null;
    let cancellation: ReturnType<typeof store.cancelUpdate> = null;
    try {
      bound = store.bindOriginalUpdateExecutor(original, original, c.child);
      expect(bound).not.toBeNull();
      let next = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
      c.child.send({
        mode,
        lease: bound!.lease,
        identity,
        transport: initialStores,
        effect,
        result,
      });
      if (mode === "success") {
        for (const kind of ["retire", "select", "terminal"]) {
          const [message] = await next;
          expect(message.kind).toBe(kind);
          expect(message.closed).toBe(false);
          if (kind === "retire") {
            expect(fs.existsSync(effect)).toBe(false);
          } else {
            expect(fs.readFileSync(effect, "utf8")).toBe("after-retire-ack");
          }
          expect(message.args.at(-1)).toEqual(initialStores);
          if (kind !== "terminal") {
            next = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
          }
          c.child.send({ ack: message.id });
        }
      } else {
        if (mode === "terminal-race") {
          const [terminal] = await next;
          expect(terminal.kind).toBe("terminal");
          next = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
          c.child.send({ ack: terminal.id });
        }
        const [message] = await next;
        expect(message.kind).toBe("revoke");
        expect(fs.existsSync(result)).toBe(false);
        expect(message.closed).toBe(true);
        cancellation = store.cancelUpdate(original);
        expect(cancellation).not.toBeNull();
        expect(cancellation?.release()).toBe(false);
        if (mode === "disconnect") {
          c.child.send({ dropControl: true });
        } else {
          c.child.send({ ack: message.id });
        }
      }
      await c.closed;
      expect(c.child.exitCode).toBe(0);
      expect(fs.readFileSync(result, "utf8")).toBe(
        mode === "success"
          ? "terminal-acked"
          : mode === "revoke"
            ? "revoke-committed"
            : mode === "terminal-race"
              ? "terminal-revoke-joined"
              : "revoke-not-acknowledged",
      );
    } finally {
      await c.stop();
    }
    if (cancellation) {
      expect(cancellation.release()).toBe(true);
    } else {
      const returned = store.returnOriginalUpdateExecutor(original, bound!.lease);
      expect(returned).not.toBeNull();
      expect(store.release(returned!.lease)).toBe(true);
    }
  },
  30_000,
);

it("refuses a dead descendant row until its explicit native settlement", async () => {
  const f = fixture();
  const { original, identity, store } = f.acquire();
  const c = await f.spawn();
  let descendant: ManagedHandoffLease | undefined;
  try {
    const bound = store.bindOriginalUpdateExecutor(original, original, c.child);
    expect(bound).not.toBeNull();
    const message = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
    c.child.send({ orphan: true, lease: bound!.lease, identity });
    descendant = (await message)[0].orphan;
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(store.returnOriginalUpdateExecutor(original, bound!.lease)).toBeNull();
    expect(store.current(bound!.lease)).toBe(true);
    expect(store.release(descendant!)).toBe(true);
    const returned = store.returnOriginalUpdateExecutor(original, bound!.lease);
    expect(returned).not.toBeNull();
    expect(store.release(returned!.lease)).toBe(true);
  } finally {
    await c.stop();
  }
}, 30_000);

it("retains ordinary release custody after executor exit while descendant pipes remain open", async () => {
  const f = fixture();
  const { original, identity, store } = f.acquire();
  const c = await f.spawn();
  let bound: ReturnType<typeof store.bindOriginalUpdateExecutor> = null;
  let closed = false;
  void c.closed.then(() => {
    closed = true;
  });
  try {
    bound = store.bindOriginalUpdateExecutor(original, original, c.child);
    const message = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
    const exited = once(c.child, "exit", { signal: AbortSignal.timeout(10_000) });
    c.child.send({ holdPipe: true, lease: bound!.lease, identity });
    expect((await message)[0].holder).toBeGreaterThan(0);
    await exited;
    expect(closed).toBe(false);
    expect(store.release(bound!.lease)).toBe(false);
    expect(store.releaseAll([bound!.lease])).toBe(false);
    expect(store.bind(bound!.lease, process.pid)).toBeNull();
    expect(store.returnOriginalUpdateExecutor(original, bound!.lease)).toBeNull();
  } finally {
    await c.stop();
  }
  const returned = store.returnOriginalUpdateExecutor(original, bound!.lease);
  expect(returned).not.toBeNull();
  expect(store.release(returned!.lease)).toBe(true);
}, 30_000);

it.each(["rejected", "missing-pair"] as const)(
  "cannot turn failed managed admission into a fence on retry: %s",
  async (failure) => {
    const f = fixture();
    const { original, identity, store } = f.acquire();
    const c = await f.spawn();
    const result = path.join(f.root, "retry-result");
    let bound: ReturnType<typeof store.bindOriginalUpdateExecutor> = null;
    let cancelled: ReturnType<typeof store.cancelUpdate> = null;
    try {
      bound = store.bindOriginalUpdateExecutor(original, original, c.child);
      const revoke =
        failure === "missing-pair"
          ? once(c.child, "message", { signal: AbortSignal.timeout(10_000) })
          : undefined;
      c.child.send({
        retryIssuer: failure,
        serviceRoot: f.retained,
        lease: bound!.lease,
        identity,
        result,
        transport: f.transport(),
      });
      if (revoke) {
        const [request] = await revoke;
        expect(request.kind).toBe("revoke");
        cancelled = store.cancelUpdate(original);
        expect(cancelled).not.toBeNull();
        expect(cancelled?.release()).toBe(false);
        c.child.send({ ack: request.id });
      }
      await c.closed;
      expect(c.child.exitCode).toBe(0);
      expect(fs.readFileSync(result, "utf8")).toBe("retry-refused");
      expect(store.current(bound!.lease)).toBe(!cancelled);
    } finally {
      await c.stop();
    }
    if (cancelled) {
      expect(cancelled.release()).toBe(true);
    } else {
      const returned = store.returnOriginalUpdateExecutor(original, bound!.lease);
      expect(returned).not.toBeNull();
      expect(store.releaseOriginalUpdate(original, returned!.lease)).toBe(true);
    }
  },
  30_000,
);

it("selects the actual planned retained root through the helper before child mutation", async () => {
  const f = fixture();
  const { original, identity, store } = f.acquire();
  const c = await f.spawn();
  try {
    const bound = store.bindOriginalUpdateExecutor(original, original, c.child)!;
    const busy = f.initial.acquire(f.retained, "other", { kind: "update" });
    expect(busy.kind).toBe("acquired");
    expect(store.selectOriginalUpdateRetainedRoot(original, bound.lease, f.retained)).toBeNull();
    expect(store.current(bound.lease)).toBe(true);
    if (busy.kind !== "acquired") {
      throw new Error("Missing busy service row");
    }
    expect(store.release(busy.lease)).toBe(true);
    expect(
      store.selectOriginalUpdateRetainedRoot(structuredClone(original), bound.lease, f.retained),
    ).toBeNull();
    const effect = path.join(f.root, "planned-effect");
    const result = path.join(f.root, "planned-result");
    const planned = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
    c.child.send({
      planPair: true,
      lease: bound.lease,
      identity,
      serviceRoot: f.retained,
      transport: f.transport(),
      effect,
      result,
    });
    const [plan] = await planned;
    expect(plan.kind).toBe("plan");
    expect(plan.args).toEqual([f.retained]);
    expect(fs.existsSync(effect)).toBe(false);
    const selected = store.selectOriginalUpdateRetainedRoot(original, bound.lease, f.retained);
    expect(selected?.retainedLease?.executor).toEqual(bound.lease.executor);
    expect(selected?.retainedLease?.helper).toEqual(original.helper);
    expect(store.selectOriginalUpdateRetainedRoot(original, bound.lease, null)).toBeNull();
    expect(store.selectOriginalUpdateRetainedRoot(original, bound.lease, f.retained)).toEqual(
      selected,
    );
    const terminal = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
    c.child.send({ ack: plan.id });
    const [snapshot] = await terminal;
    expect(snapshot.kind).toBe("terminal");
    expect(fs.readFileSync(effect, "utf8")).toBe("pair-admitted");
    c.child.send({ ack: snapshot.id });
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(fs.readFileSync(result, "utf8")).toBe("planned-pair-settled");
  } finally {
    await c.stop();
  }
  const cancelled = store.cancelUpdate(original);
  expect(cancelled?.release()).toBe(true);
  expect(store.read(f.retained).kind).toBe("absent");
}, 30_000);

it("refuses a planned retained root different from its pre-admitted pair", () => {
  const f = fixture(true);
  const { original, retainedLease, store } = f.acquire();
  if (!retainedLease) {
    throw new Error("Paired fixture did not pre-admit its retained root.");
  }
  const other = path.join(f.root, "other-retained");
  fs.mkdirSync(other, { mode: 0o700 });
  expect(store.selectOriginalUpdateRetainedRoot(original, original, other)).toBeNull();
  expect(store.selectOriginalUpdateRetainedRoot(original, original, f.retained)).toMatchObject({
    retainedLease: { key: retainedLease.key },
  });
  const cancelled = store.cancelUpdate(original);
  expect(cancelled?.release()).toBe(true);
});

it("retains a real top-level occupied slot through return and cancellation settlement", async () => {
  const f = fixture();
  const { original, identity, store } = f.acquire();
  const c = await f.spawn();
  let slot: ManagedHandoffLease | undefined;
  try {
    const bound = store.bindOriginalUpdateExecutor(original, original, c.child);
    const message = once(c.child, "message", { signal: AbortSignal.timeout(10_000) });
    c.child.send({ slot: f.retained, lease: bound!.lease, identity });
    const [reply] = await message;
    slot = reply.slot;
    const descendant = reply.descendant as ManagedHandoffLease;
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(store.returnOriginalUpdateExecutor(original, bound!.lease)).toBeNull();
    const cancelled = store.cancelUpdate(original);
    expect(cancelled).not.toBeNull();
    expect(cancelled?.release()).toBe(false);
    expect(cancelled?.release([slot!])).toBe(false);
    expect(store.read(f.install).kind).toBe("current");
    expect(store.read(f.retained).kind).toBe("current");
    expect(store.release(descendant)).toBe(true);
    expect(cancelled?.release([slot!])).toBe(true);
    expect(store.read(f.install).kind).toBe("absent");
    expect(store.read(f.retained).kind).toBe("absent");
  } finally {
    await c.stop();
  }
}, 30_000);

it("refuses a newly selected service root while a dead descendant row remains", async () => {
  const f = fixture();
  const { original, identity, store } = f.acquire();
  const service = store.acquire(f.retained, "prior-service", { kind: "update" });
  if (service.kind !== "acquired") {
    throw new Error("Missing service parent");
  }
  const orphan = await f.spawn();
  let descendant: ManagedHandoffLease | undefined;
  try {
    const message = once(orphan.child, "message", { signal: AbortSignal.timeout(10_000) });
    orphan.child.send({ orphan: true, lease: service.lease, identity });
    descendant = (await message)[0].orphan;
    await orphan.closed;
    expect(orphan.child.exitCode).toBe(0);
  } finally {
    await orphan.stop();
  }
  expect(store.release(service.lease)).toBe(true);
  expect(store.read(f.retained).kind).toBe("absent");
  const fresh = path.join(f.root, "fresh-install");
  fs.mkdirSync(fresh);
  const paired = createManagedHandoffLeaseStore({
    databasePath: identity.databasePath,
    existingIdentity: identity,
    originalUpdateKey: fresh,
    originalUpdateRetainedKey: f.retained,
    serviceManagerEnv: process.env,
  });
  expect(paired.acquire(fresh, "fresh-original", { kind: "update" })).toEqual({
    kind: "busy",
    owner: descendant!.owner,
  });
  expect(paired.read(fresh).kind).toBe("absent");
  expect(paired.read(f.retained).kind).toBe("absent");
  const c = await f.spawn();
  let bound: ReturnType<typeof store.bindOriginalUpdateExecutor> = null;
  try {
    bound = store.bindOriginalUpdateExecutor(original, original, c.child);
    expect(store.selectOriginalUpdateRetainedRoot(original, bound!.lease, f.retained)).toBeNull();
    expect(store.read(f.retained).kind).toBe("absent");
    expect(store.release(descendant!)).toBe(true);
    expect(
      store.selectOriginalUpdateRetainedRoot(original, bound!.lease, f.retained),
    ).not.toBeNull();
  } finally {
    await c.stop();
  }
  const returned = store.returnOriginalUpdateExecutor(original, bound!.lease);
  expect(returned).not.toBeNull();
  expect(store.releaseOriginalUpdate(original, returned!.lease)).toBe(true);
}, 30_000);
