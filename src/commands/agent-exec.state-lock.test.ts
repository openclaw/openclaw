import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  recordAgentCleanupFailure,
  createAgentCleanupScope,
} from "../agents/run-cleanup-timeout.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as embeddedStateLock from "../infra/embedded-state-lock.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { registerSqliteAuditRecordAsync } from "../infra/sqlite-audit-record-store.async.js";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const acquireStateLock = embeddedStateLock.acquireEmbeddedStateLock;
const createSignalBridge = embeddedStateLock.createEmbeddedStateSignalBridge;
afterEach(() => vi.restoreAllMocks());
const success = () => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });
function stateFixture() {
  const stateDir = tempDirs.make("openclaw-agent-exec-lock-");
  const lockDir = path.join(stateDir, "gateway-locks");
  const lockOptions = {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir,
    timeoutMs: 100,
    readProcessStartTime: () => 123_456,
  };
  vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockImplementation((params) =>
    acquireStateLock({ ...params, options: lockOptions }),
  );
  return { stateDir, lockOptions, lockPath: path.join(lockDir, "gateway.state.lock") };
}
async function expectLock(lockPath: string) {
  expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
    pid: process.pid,
    role: "agent-embedded",
  });
}

describe("agent exec retained-state ownership", () => {
  it.each([false, true])(
    "preserves state after uncertain runtime cleanup (retained: %s)",
    async (retained) => {
      const fixture = retained ? stateFixture() : undefined;
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const cleanupScope = createAgentCleanupScope();
      let stateDir = "";
      try {
        const result = await cleanupScope.run(() =>
          runAgentExecWithMock(
            "inspect",
            fixture ? { stateDir: fixture.stateDir } : {},
            createTestRuntime(),
            async () => {
              stateDir = process.env.OPENCLAW_STATE_DIR!;
              await fs.writeFile(path.join(stateDir, "owned-work"), "still owned");
              recordAgentCleanupFailure();
              return success();
            },
          ),
        );
        expect(result.exitCode).toBe(1);
        expect(cleanupScope.outcome).toBe("uncertain");
        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        if (fixture) {
          await expectLock(fixture.lockPath);
        }
        await expect(fs.readFile(path.join(stateDir, "owned-work"), "utf8")).resolves.toBe(
          "still owned",
        );
      } finally {
        if (stateDir) {
          await fs.rm(stateDir, { recursive: true, force: true });
        }
      }
    },
  );

  it("refuses a state directory owned by a live Gateway", async () => {
    const { stateDir, lockOptions } = stateFixture();
    const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
    if (!gatewayLock) {
      throw new Error("Expected live Gateway fixture lock");
    }
    const runAgent = vi.fn(async () => success());
    const runtime = createTestRuntime();
    try {
      const result = await runAgentExecWithMock("inspect", { stateDir }, runtime, runAgent);
      expect(result.exitCode).toBe(1);
      expect(runAgent).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Omit --state-dir to use isolated temporary state, or stop the Gateway first (openclaw gateway stop).`,
      );
    } finally {
      await gatewayLock.release();
    }
  });

  it("holds and releases the embedded state lock around the run", async () => {
    const { stateDir, lockPath } = stateFixture();
    await fs.writeFile(path.join(stateDir, "keep.txt"), "keep");
    const result = await runAgentExecWithMock(
      "inspect",
      { stateDir },
      createTestRuntime(),
      async () => {
        await expectLock(lockPath);
        return success();
      },
    );
    expect(result.exitCode).toBe(0);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(stateDir, "keep.txt"), "utf8")).resolves.toBe("keep");
    expect((await fs.readdir(stateDir)).toSorted()).toEqual(["gateway-locks", "keep.txt", "tmp"]);
  });

  it("releases the embedded state lock when SIGTERM aborts the run", async () => {
    const { stateDir, lockPath } = stateFixture();
    const signals = new EventEmitter();
    const entered = createDeferred();
    const runtime = createTestRuntime();
    vi.spyOn(embeddedStateLock, "createEmbeddedStateSignalBridge").mockImplementation(() =>
      createSignalBridge(signals),
    );
    const run = runAgentExecWithMock("inspect", { stateDir }, runtime, async (opts) => {
      const signal = opts.abortSignal as AbortSignal;
      const pending = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("agent exec aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      entered.resolve();
      return pending;
    });
    await Promise.race([
      entered.promise,
      run.then(() => {
        throw new Error("Run ended before signal admission");
      }),
    ]);
    signals.emit("SIGTERM");
    await run;
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.exit).toHaveBeenCalledWith(143, { resetStream: process.stderr });
  });
});

it("closes temporary databases before removal and preserves independent handles", async () => {
  const independentRoot = tempDirs.make("openclaw-agent-exec-independent-");
  const independent = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: independentRoot },
  });
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  let runStateDir: string | undefined;
  let agentPath: string | undefined;
  let statePath: string | undefined;
  const handles: DatabaseSync[] = [];
  const remove = fs.rm.bind(fs);
  const removed = vi.spyOn(fs, "rm").mockImplementation(async (pathname, options) => {
    if (pathname === runStateDir) {
      // Refuse the destructive step if the command has not settled native ownership.
      expect(handles).toHaveLength(2);
      expect(handles.every((handle) => !handle.isOpen)).toBe(true);
      expect(independent.db.isOpen).toBe(true);
    }
    await remove(pathname, options);
  });
  try {
    const result = await runAgentExecWithMock(
      "inspect",
      { authEnvOnly: true },
      runtime,
      async () => {
        runStateDir = process.env.OPENCLAW_STATE_DIR;
        const shared = openOpenClawStateDatabase();
        handles.push(shared.db);
        statePath = shared.path;
        await withOpenClawAgentDatabaseAsync({ agentId: "main" }, (database) => {
          handles.push(database.db);
          agentPath = database.path;
        });
        const storePath = path.join(runStateDir!, "agents", "main", "sessions", "sessions.json");
        const sessionKey = "agent:main:exec-cleanup";
        await replaceSessionEntry(
          { sessionKey, storePath },
          { sessionId: "exec-cleanup", updatedAt: 1 },
        );
        const deletion = await deleteSessionEntryLifecycle({
          agentId: "main",
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        expect(deletion.deleted).toBe(true);
        await registerSqliteAuditRecordAsync(
          { scope: "agent-exec-cleanup", maxEntries: 1 },
          { key: "completed", value: "synthetic", createdAt: 1 },
        );
        expect(
          createSqliteAuditRecordStore({ scope: "agent-exec-cleanup", maxEntries: 1 }).entries(),
        ).toEqual([{ key: "completed", value: "synthetic", createdAt: 1 }]);
        return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
      },
    );
    expect(result.exitCode).toBe(0);
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    expect(runStateDir).toBeDefined();
    await expect(fs.stat(runStateDir!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(independent.db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  } finally {
    removed.mockRestore();
    if (agentPath) {
      await closeOpenClawAgentDatabaseByPathAsync(agentPath);
    }
    if (statePath) {
      await closeOpenClawStateDatabaseByPathAsync(statePath);
    }
    await closeOpenClawStateDatabaseByPathAsync(independent.path);
    if (runStateDir) {
      await remove(runStateDir, { recursive: true, force: true });
    }
  }
});
