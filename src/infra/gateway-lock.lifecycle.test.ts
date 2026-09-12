import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { acquireGatewayLifecycleCoordinator } from "./state-database-coordinator.js";

const children = new Map<ChildProcess, Promise<unknown[]>>();
afterEach(async () => {
  for (const child of children.keys()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(children.values());
  children.clear();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function holdLifecycleCoordinator() {
  const stateDir = tempDirs.make("openclaw-lifecycle-handoff-");
  const coordinator = acquireGatewayLifecycleCoordinator({
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
  });
  coordinator.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(process.argv[1]);
       db.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
       process.on("message", () => setTimeout(() => {
         db.exec("ROLLBACK"); db.close(); process.disconnect();
       }, 2000));
       process.send("held");`,
      coordinator.path,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  children.set(child, once(child, "close"));
  await withTestTimeout(once(child, "message"), 5_000, "coordinator fixture did not start");
  return {
    child,
    options: { env: { OPENCLAW_STATE_DIR: stateDir }, allowInTests: true },
  };
}

describe("Gateway lifecycle ownership handoff", () => {
  it("acquires when the predecessor releases two seconds after startup", async () => {
    const { child, options } = await holdLifecycleCoordinator();
    child.send("release-after-delay");
    const lock = await acquireGatewayLock(options);
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it("bounds a live owner's wait at five minutes and names the coordinator", async () => {
    const { options } = await holdLifecycleCoordinator();
    let elapsedMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      elapsedMs += ms;
    });
    await expect(acquireGatewayLock({ ...options, now: () => elapsedMs, sleep })).rejects.toThrow(
      "failed to acquire gateway state ownership; waited 300000ms for gateway-lifecycle ownership",
    );
    expect(elapsedMs).toBe(300_000);
    expect(sleep).toHaveBeenCalled();
  });
});
