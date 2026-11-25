import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { removeStateAndLinkedPaths } from "./cleanup-utils.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function cleanupFixture() {
  const stateDir = tempDirs.make("openclaw-cleanup-handle-");
  const configPath = path.join(stateDir, "openclaw.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.writeFileSync(configPath, "{}\n");
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const paths = {
    stateDir,
    configPath,
    oauthDir: path.join(stateDir, "credentials"),
    configInsideState: true,
    oauthInsideState: true,
  };
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const remove = () => removeStateAndLinkedPaths(paths, runtime);
  return { stateDir, configPath, databasePath, options, remove };
}

function startPeer(
  script: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
  execArgs: string[] = [],
) {
  const child = spawn(
    process.execPath,
    [...execArgs, "--input-type=module", "--eval", script, ...args],
    { env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const closed = once(child, "close");
  void closed.catch(() => {});
  const receive = (signal: AbortSignal, phase: string) => {
    const message = once(child, "message", { signal });
    const reply = awaitGateBeforeSettlement(message, closed, `Peer closed before ${phase}`);
    return withinTest(reply, signal);
  };
  return { child, closed, receive };
}

async function expectFirst(expected: string, pending: Record<string, Promise<unknown>>) {
  const settled = Object.entries(pending).map(async ([name, promise]) => {
    await promise;
    return name;
  });
  expect(await Promise.race(settled)).toBe(expected);
}

function pauseRemoval(configPath: string, databasePath: string, afterRemove?: () => Promise<void>) {
  const started = createDeferred(),
    resume = createDeferred();
  const realRm = fsPromises.rm;
  const remove = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, settings) => {
    if (String(target) === configPath || String(target) === path.dirname(databasePath)) {
      started.resolve();
      await resume.promise;
    }
    await realRm(target, settings);
    if (String(target) === path.dirname(databasePath)) {
      await afterRemove?.();
    }
  });
  return { started: started.promise, resume: resume.resolve, restore: () => remove.mockRestore() };
}

it.skipIf(process.platform === "win32")(
  "retains native SQLite exclusion through removal against a legacy rollback-mode writer",
  async ({ signal }) => {
    const { stateDir, configPath, databasePath, remove: removeState } = cleanupFixture();
    fs.mkdirSync(path.dirname(databasePath));
    // A shipped native client does not know the new process-owner sidecar.
    const { child, closed, receive } = startPeer(
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
      [databasePath],
    );
    const removal = pauseRemoval(configPath, databasePath);
    const attemptWrite = async () => {
      const reply = receive(signal, "replying");
      child.send("write");
      const [outcome] = await reply;
      return outcome;
    };
    let deleting: Promise<boolean> | undefined;
    try {
      const [ready] = await receive(signal, "readiness");
      expect(ready).toEqual({ ready: true });
      deleting = removeState();
      await expectFirst("removing", { removing: removal.started, removed: deleting });
      expect(fs.existsSync(databasePath)).toBe(true);
      await expect(attemptWrite()).resolves.toEqual({ committed: false, errcode: 5 });
      removal.resume();
      await expect(deleting).resolves.toBe(true);
      // Apple's SQLite VFS reports an unlinked vnode; bundled SQLite reports a moved database.
      const removedFileCode = process.versions.bun && process.platform === "darwin" ? 6922 : 1032;
      await expect(attemptWrite()).resolves.toEqual({ committed: false, errcode: removedFileCode });
      expect(fs.existsSync(stateDir)).toBe(false);
      child.send("close");
      await withinTest(closed, signal);
    } finally {
      removal.resume();
      try {
        await deleting;
      } finally {
        removal.restore();
        await stopChildProcess(child, 5_000);
      }
    }
  },
);

it("refuses state removal while a peer owns a cached database, then removes after peer retirement", async ({
  signal,
}) => {
  const { stateDir, configPath, databasePath, options, remove } = cleanupFixture();
  const moduleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
  const { child, closed, receive } = startPeer(
    `
    import { openOpenClawStateDatabase, closeOpenClawStateDatabase } from ${JSON.stringify(moduleUrl.href)};
    const owner = openOpenClawStateDatabase();
    process.send({ ready: true, path: owner.path });
    process.once("message", () => {
      closeOpenClawStateDatabase();
      process.disconnect();
    });
  `,
    [],
    options.env,
    resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
  );
  try {
    const [ready] = await receive(signal, "readiness");
    expect(ready).toMatchObject({ ready: true });
    await expect(remove()).rejects.toThrow(
      "Cannot remove OpenClaw state directory while another SQLite connection is active",
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
    expect(fs.existsSync(databasePath)).toBe(true);
    child.send({ close: true });
    await withinTest(closed, signal);
    await expect(remove()).resolves.toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);
  } finally {
    await stopChildProcess(child, 5_000);
  }
});

it("drains the local cache and excludes reopening throughout awaited removal", async () => {
  const { stateDir, configPath, options, remove: removeState } = cleanupFixture();
  const database = openOpenClawStateDatabase(options);
  const retainedStatement = database.db.prepare("PRAGMA data_version");
  retainedStatement.get();
  const unlinked = createDeferred();
  const resumeFinalization = createDeferred();
  const entryName = (entry: string | Buffer | fs.Dirent<string | Buffer>) =>
    typeof entry === "string" || Buffer.isBuffer(entry) ? entry.toString() : entry.name.toString();
  const readdir = fsPromises.readdir.bind(fsPromises);
  const discovery = vi
    .spyOn(fsPromises, "readdir")
    .mockImplementation(async (directory, settings) => {
      const entries = await readdir(directory, settings);
      // Directory enumeration may reach the database before the config file.
      return String(directory) === stateDir
        ? entries.toSorted(
            (left, right) =>
              Number(entryName(right) === "state") - Number(entryName(left) === "state"),
          )
        : entries;
    });
  const removal = pauseRemoval(configPath, database.path, async () => {
    unlinked.resolve();
    await resumeFinalization.promise;
  });
  const deleting = removeState();
  try {
    await expectFirst("removing", {
      removing: removal.started,
      unlinked: unlinked.promise,
      removed: deleting,
    });
    expect(database.db.isOpen).toBe(false);
    expect(() => retainedStatement.get()).toThrow(/finalized|database is not open/);
    const before = fs.statSync(database.path, { bigint: true });
    expect(() => openOpenClawStateDatabase(options)).toThrow(
      "without an active schema lease or maintenance scope",
    );
    expect(fs.statSync(database.path, { bigint: true })).toEqual(before);
    removal.resume();
    await expectFirst("unlinked", { unlinked: unlinked.promise, removed: deleting });
    expect([database.path, path.dirname(database.path)].map(fs.existsSync)).toEqual([false, false]);
    expect(() => openOpenClawStateDatabase(options)).toThrow(
      "without an active schema lease or maintenance scope",
    );
    expect([database.path, path.dirname(database.path)].map(fs.existsSync)).toEqual([false, false]);
  } finally {
    removal.resume();
    resumeFinalization.resolve();
    await deleting.finally(() => {
      removal.restore();
      discovery.mockRestore();
      closeOpenClawStateDatabaseForTest();
    });
  }
  expect(fs.existsSync(stateDir)).toBe(false);
  const reopened = openOpenClawStateDatabase(options);
  expect(reopened.db.isOpen).toBe(true);
  closeOpenClawStateDatabaseForTest();
});
