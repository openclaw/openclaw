import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";

export async function holdStateCoordinator(databasePath: string, releaseAfterMs = 0) {
  // Initialize the real coordinator location/permissions through its owner.
  const coordinator = acquireStateDatabaseCoordinator({ databasePath });
  const coordinatorPath = coordinator.path;
  coordinator.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { DatabaseSync } from "node:sqlite";
    process.title = "openclaw-lock-fixture";
    const db = new DatabaseSync(${JSON.stringify(coordinatorPath)});
    db.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
    process.send({ ready: true });
    process.on("message", (message) => {
      if (message.observe) {
        process.send({ held: db.isTransaction });
        return;
      }
      if (!message.release) return;
      setTimeout(() => {
        process.removeAllListeners("message");
        db.exec("ROLLBACK");
        db.close();
        process.disconnect();
      }, ${releaseAfterMs});
    });
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    expect(message).toEqual({ ready: true });
  } catch (error) {
    await stopChildProcess(child, 5_000);
    throw error;
  }
  const release = async () => {
    try {
      const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      child.send({ release: true });
      await closed;
    } finally {
      await stopChildProcess(child, 5_000);
    }
  };
  return Object.assign(release, {
    pid: child.pid,
    async observe() {
      const observed = once(child, "message", { signal: AbortSignal.timeout(5_000) });
      child.send({ observe: true });
      const [message] = await observed;
      expect(message).toEqual({ held: true });
    },
  });
}
