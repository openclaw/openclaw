import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  classifyGatewayLockProcessNamespace,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { acquireStateDatabaseSchemaLease } from "./gateway-state-owner.js";
import * as workerCpu from "./worker-cpu.js";

vi.mock("./gateway-lock-payload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-lock-payload.js")>()),
  GATEWAY_OWNER_HEARTBEAT_MS: 1_000,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("renews retained custody during synchronous work and never touches a successor", async () => {
  const workers: Worker[] = [];
  const ready: Promise<unknown>[] = [];
  const createWorker = workerCpu.createCpuTrackedWorker;
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = createWorker(...args);
    workers.push(worker);
    ready.push(once(worker, "message"));
    return worker;
  });
  const root = tempDirs.make("openclaw-owner-worker-");
  const gateway = await acquireGatewayLock({
    allowInTests: true,
    env: { OPENCLAW_STATE_DIR: root },
    timeoutMs: 0,
  });
  if (!gateway) {
    throw new Error("Expected Gateway custody");
  }
  const retained = acquireStateDatabaseSchemaLease(path.join(root, "state", "openclaw.sqlite"));
  try {
    await Promise.all(ready);
    const files = [gateway.lockPath, gateway.stateLockPath].map((lockPath) => ({
      lockPath,
      raw: fs.readFileSync(lockPath, "utf8"),
      before: fs.statSync(lockPath, { bigint: true }),
    }));
    await gateway.release();
    // Real synchronous blocking is the regression: a parent timer cannot run here.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
    retained.assertCurrent();
    const namespace = readGatewayLockProcessNamespace();
    expect(namespace).not.toBeNull();
    // Give the production classifier a two-second freshness window without changing its API.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + GATEWAY_OWNER_HEARTBEAT_STALE_MS - 2_000);
    for (const file of files) {
      const after = fs.statSync(file.lockPath, { bigint: true });
      expect(after.mtimeNs).toBeGreaterThan(file.before.mtimeNs);
      expect(after.ino).toBe(file.before.ino);
      expect(fs.readFileSync(file.lockPath, "utf8")).toBe(file.raw);
      expect(
        classifyGatewayLockProcessNamespace(
          { ...namespace, pidNamespace: "foreign-observer" },
          file.lockPath,
        ),
      ).toBe("unknown");
    }
    vi.mocked(Date.now).mockRestore();
    fs.unlinkSync(gateway.lockPath);
    fs.writeFileSync(gateway.lockPath, "successor");
    const replaced = files.map((file) => fs.statSync(file.lockPath, { bigint: true }).mtimeNs);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
    expect(files.map((file) => fs.statSync(file.lockPath, { bigint: true }).mtimeNs)).toEqual(
      replaced,
    );
    expect(() => retained.assertCurrent()).toThrow("no longer current");
    expect(workers).toHaveLength(1);
    const exited = once(workers[0]!, "exit");
    retained.release();
    await exited;
    expect(fs.readFileSync(gateway.lockPath, "utf8")).toBe("successor");
    expect(fs.existsSync(gateway.stateLockPath)).toBe(false);
  } finally {
    retained.release();
    await gateway.release();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});
