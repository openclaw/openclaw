import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { RuntimeEnv } from "../runtime.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { removeStateAndLinkedPaths } from "./cleanup-utils.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "retains native SQLite exclusion through removal against a legacy rollback-mode writer",
  async () => {
    const stateDir = tempDirs.make("openclaw-cleanup-legacy-writer-");
    const configPath = path.join(stateDir, "openclaw.json");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath));
    fs.writeFileSync(configPath, "{}\n");
    // A shipped native client does not know the new process-owner sidecar.
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.argv[1]);
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; CREATE TABLE marker(value INTEGER); INSERT INTO marker VALUES (1)");
      process.on("message", (message) => {
        if (message === "close") {
          database.close();
          process.disconnect();
          return;
        }
        let outcome;
        try {
          database.exec("BEGIN IMMEDIATE; INSERT INTO marker VALUES (2); COMMIT");
          outcome = { committed: true };
        } catch (error) {
          outcome = { committed: false, errcode: error.errcode };
        } finally {
          if (database.isTransaction) database.exec("ROLLBACK");
        }
        process.send(outcome);
      });
      process.send({ ready: true });
    `,
        databasePath,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const started = createDeferred();
    const resumeRemoval = createDeferred();
    const realRm = fsPromises.rm;
    const remove = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, settings) => {
      if (String(target) === configPath) {
        started.resolve();
        await resumeRemoval.promise;
      }
      return realRm(target, settings);
    });
    const attemptWrite = async () => {
      const reply = once(child, "message", { signal: AbortSignal.timeout(10_000) });
      child.send("write");
      const [outcome] = await reply;
      return outcome;
    };
    let deleting: Promise<boolean> | undefined;
    try {
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
      expect(ready).toEqual({ ready: true });
      deleting = removeStateAndLinkedPaths(
        {
          stateDir,
          configPath,
          oauthDir: path.join(stateDir, "credentials"),
          configInsideState: true,
          oauthInsideState: true,
        },
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      );
      expect(
        await Promise.race([
          started.promise.then(() => "removing"),
          deleting.then(() => "removed"),
        ]),
      ).toBe("removing");
      expect(fs.existsSync(databasePath)).toBe(true);
      await expect(attemptWrite()).resolves.toEqual({ committed: false, errcode: 5 });
      resumeRemoval.resolve();
      await expect(deleting).resolves.toBe(true);
      await expect(attemptWrite()).resolves.toEqual({ committed: false, errcode: 1032 });
      expect(fs.existsSync(stateDir)).toBe(false);
      const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) });
      child.send("close");
      await closed;
    } finally {
      resumeRemoval.resolve();
      try {
        await deleting;
      } finally {
        remove.mockRestore();
        await stopChildProcess(child, 5_000);
      }
    }
  },
);

it("refuses state removal while a peer owns a cached database, then removes after peer retirement", async () => {
  const stateDir = tempDirs.make("openclaw-cleanup-handle-exclusion-");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  const moduleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      `
    import { openOpenClawStateDatabase, closeOpenClawStateDatabase } from ${JSON.stringify(moduleUrl.href)};
    const owner = openOpenClawStateDatabase();
    process.send({ ready: true, path: owner.path });
    process.once("message", () => {
      closeOpenClawStateDatabase();
      process.disconnect();
    });
  `,
    ],
    {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const plan = {
    stateDir,
    configPath,
    oauthDir: path.join(stateDir, "credentials"),
    configInsideState: true,
    oauthInsideState: true,
  };
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
    expect(ready).toMatchObject({ ready: true });
    await expect(removeStateAndLinkedPaths(plan, runtime)).rejects.toThrow(
      "Cannot remove OpenClaw state directory while another SQLite connection is active",
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) });
    child.send({ close: true });
    await closed;
    await expect(removeStateAndLinkedPaths(plan, runtime)).resolves.toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);
  } finally {
    await stopChildProcess(child, 5_000);
  }
});

it("drains the local cache and excludes reopening throughout awaited removal", async () => {
  const stateDir = tempDirs.make("openclaw-cleanup-local-handle-");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const database = openOpenClawStateDatabase(options);
  const retainedStatement = database.db.prepare("PRAGMA data_version");
  retainedStatement.get();
  const started = createDeferred();
  const resumeRemoval = createDeferred();
  const unlinked = createDeferred();
  const resumeFinalization = createDeferred();
  const realRm = fsPromises.rm;
  const remove = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, settings) => {
    if (String(target) === configPath) {
      started.resolve();
      await resumeRemoval.promise;
    }
    await realRm(target, settings);
    if (String(target) === path.dirname(database.path)) {
      unlinked.resolve();
      await resumeFinalization.promise;
    }
  });
  const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const deleting = removeStateAndLinkedPaths(
    {
      stateDir,
      configPath,
      oauthDir: path.join(stateDir, "credentials"),
      configInsideState: true,
      oauthInsideState: true,
    },
    runtime,
  );
  try {
    expect(
      await Promise.race([started.promise.then(() => "removing"), deleting.then(() => "removed")]),
    ).toBe("removing");
    expect(database.db.isOpen).toBe(false);
    expect(() => retainedStatement.get()).toThrow(/finalized/);
    const before = fs.statSync(database.path, { bigint: true });
    expect(() => openOpenClawStateDatabase(options)).toThrow("offline maintenance");
    expect(fs.statSync(database.path, { bigint: true })).toEqual(before);
    resumeRemoval.resolve();
    expect(
      await Promise.race([unlinked.promise.then(() => "unlinked"), deleting.then(() => "removed")]),
    ).toBe("unlinked");
    expect(fs.existsSync(database.path)).toBe(false);
    expect(fs.existsSync(path.dirname(database.path))).toBe(false);
    expect(() => openOpenClawStateDatabase(options)).toThrow("offline maintenance");
    expect(fs.existsSync(database.path)).toBe(false);
    expect(fs.existsSync(path.dirname(database.path))).toBe(false);
  } finally {
    resumeRemoval.resolve();
    resumeFinalization.resolve();
    await deleting.finally(() => {
      remove.mockRestore();
      closeOpenClawStateDatabaseForTest();
    });
  }
  expect(fs.existsSync(stateDir)).toBe(false);
  const reopened = openOpenClawStateDatabase(options);
  expect(reopened.db.isOpen).toBe(true);
  closeOpenClawStateDatabaseForTest();
});
