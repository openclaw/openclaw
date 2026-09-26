import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "./state-database-coordinator.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-reclamation-")));
  roots.push(root);
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
  const coordinator = make("coordinator");
  const { databasePath: handoff } = installPrivateUpdateHandoffStore(privateTmp);
  const childEnv = writePrivateUpdateHandoffChildGuard(handoff, privateTmp);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
  const env = childEnv({
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  });
  const store = createManagedHandoffLeaseStore({ databasePath: handoff, serviceManagerEnv: env });
  const child = path.join(root, "original-owner.mts");
  const executorUrl = new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href;
  const coordinatorUrl = new URL("./state-database-coordinator.ts", import.meta.url).href;
  const leaseUrl = new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href;
  const crash = (mode: "ordinary" | "cancelled" = "ordinary", holderPid?: number) => {
    fs.writeFileSync(
      child,
      `
import { createRequire } from "node:module";
createRequire(import.meta.url)(${JSON.stringify(path.join(privateTmp, "private-handoff-guard.cjs"))});
const { withUpdateCommandExecutor, requestUpdateCommandExecutorCancellation } = await import(${JSON.stringify(executorUrl)});
const { withStateDatabaseCoordinatorRuntimeDirectory } = await import(${JSON.stringify(coordinatorUrl)});
const { createManagedHandoffLeaseStore } = await import(${JSON.stringify(leaseUrl)});
const runId = ${JSON.stringify(randomUUID())};
await withStateDatabaseCoordinatorRuntimeDirectory({directory:${JSON.stringify(coordinator)},keepAlive:false}, () =>
  withUpdateCommandExecutor(runId, async (executor) => {
    const fence = await executor.enter(${JSON.stringify(slot)});
    if (${JSON.stringify(holderPid ?? null)} !== null) {
      const store = createManagedHandoffLeaseStore({databasePath:${JSON.stringify(handoff)},serviceManagerEnv:process.env});
      const current = store.read(${JSON.stringify(slot)});
      if (current.kind !== "current" || !store.bind(current.lease, ${JSON.stringify(holderPid ?? 0)})) { throw new Error("Fixture slot binding failed"); }
    }
    if (${JSON.stringify(mode)} === "cancelled") requestUpdateCommandExecutorCancellation(fence, runId, new Error("original cancellation"));
    process.kill(process.pid, "SIGKILL");
  }, {directOriginal:{databasePath:${JSON.stringify(handoff)}}}));
`,
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", child], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBe("SIGKILL");
    const original = store.read(install),
      occupied = store.read(slot);
    expect(original.kind).toBe("current");
    expect(occupied.kind).toBe("current");
    if (original.kind !== "current" || occupied.kind !== "current") {
      throw new Error("Missing crash pair");
    }
    expect(occupied.lease.version).toBe(2);
    if (occupied.lease.version !== 2) {
      throw new Error("Unexpected occupied-slot format");
    }
    expect(occupied.lease.mutationOriginal?.key).toBe(install);
    return { original, occupied };
  };
  const retry = () =>
    withStateDatabaseCoordinatorRuntimeDirectory({ directory: coordinator, keepAlive: false }, () =>
      withUpdateCommandExecutor(
        randomUUID(),
        async (executor) => {
          const fence = await executor.enter(slot);
          fence.assertCurrent();
          const original = store.read(install),
            occupied = store.read(slot);
          expect(original.kind).toBe("current");
          expect(occupied.kind).toBe("current");
          if (original.kind !== "current" || occupied.kind !== "current") {
            throw new Error("Missing new pair");
          }
          expect(original.lease.helper.pid).toBe(process.pid);
          expect(occupied.lease.owner).toBe(original.lease.owner);
          expect(store.current(original.lease)).toBe(true);
          expect(store.current(occupied.lease)).toBe(true);
        },
        { directOriginal: { databasePath: handoff } },
      ),
    );
  return { root, install, slot, handoff, store, env, crash, retry };
}

it("reclaims a crashed original and its occupied slot together, then releases the new pair", async () => {
  const f = fixture();
  f.crash();
  await f.retry();
  expect(f.store.read(f.install).kind).toBe("absent");
  expect(f.store.read(f.slot).kind).toBe("absent");
});

it("preserves both old generations while the occupied slot still has a live executor", async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    env: f.env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const closed = once(holder, "close");
  try {
    await once(holder, "spawn");
    if (!holder.pid) {
      throw new Error("Missing holder pid");
    }
    const before = f.crash("ordinary", holder.pid);
    await expect(f.retry()).rejects.toThrow("Another update executor");
    expect(f.store.read(f.install)).toEqual(before.original);
    expect(f.store.read(f.slot)).toEqual(before.occupied);
  } finally {
    holder.kill("SIGKILL");
    await closed;
  }
  await f.retry();
  expect(f.store.read(f.install).kind).toBe("absent");
  expect(f.store.read(f.slot).kind).toBe("absent");
});

it("does not reclaim original cancellation custody after the process dies", async () => {
  const f = fixture();
  const before = f.crash("cancelled");
  expect(before.original.lease.version).toBe(4);
  await expect(f.retry()).rejects.toThrow("Another update executor");
  expect(f.store.read(f.install)).toEqual(before.original);
  expect(f.store.read(f.slot)).toEqual(before.occupied);
});

it.each(["release", "releaseAll"] as const)(
  "%s preserves an original until its exact occupied generation settles",
  (method) => {
    const f = fixture();
    const store = createManagedHandoffLeaseStore({
      databasePath: f.handoff,
      serviceManagerEnv: f.env,
      originalUpdateKey: f.install,
    });
    const original = store.acquire(f.install, "original", { kind: "update" });
    if (original.kind !== "acquired") {
      throw new Error("Original acquisition failed");
    }
    const occupied = store.acquire(
      f.slot,
      "original",
      { kind: "update" },
      false,
      undefined,
      original.lease,
    );
    if (occupied.kind !== "acquired") {
      throw new Error("Occupied acquisition failed");
    }
    const beforeOriginal = store.read(f.install);
    const beforeOccupied = store.read(f.slot);
    expect(
      method === "release" ? store.release(original.lease) : store.releaseAll([original.lease]),
    ).toBe(false);
    expect(store.read(f.install)).toEqual(beforeOriginal);
    expect(store.read(f.slot)).toEqual(beforeOccupied);
    expect(store.current(original.lease)).toBe(true);
    expect(store.current(occupied.lease)).toBe(true);
    expect(store.acquire(f.install, "contender", { kind: "update" }).kind).toBe("busy");

    const rebound = store.bind(occupied.lease, process.pid);
    if (!rebound) {
      throw new Error("Occupied rebinding failed");
    }
    expect(store.releaseAll([original.lease, occupied.lease])).toBe(false);
    expect(store.read(f.install)).toEqual(beforeOriginal);
    expect(store.current(rebound)).toBe(true);
    expect(store.releaseAll([original.lease, rebound])).toBe(true);
    expect(store.read(f.install).kind).toBe("absent");
    expect(store.read(f.slot).kind).toBe("absent");
    const next = store.acquire(f.install, "next", { kind: "update" });
    expect(next.kind).toBe("acquired");
    if (next.kind !== "acquired") {
      throw new Error("Next generation acquisition failed");
    }
    expect(store.release(next.lease)).toBe(true);
  },
);
