import fs from "node:fs/promises";
import path from "node:path";
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
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import * as processSignalBridge from "../infra/process-signal-bridge.js";
import { captureNativeSignalBridge } from "../infra/process-signal-bridge.test-support.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createSqliteAuditRecordWriter } from "../infra/sqlite-audit-record-store.async.js";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { runAgentExecWithMock as runExec } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createSignalBridge = processSignalBridge.createProcessSignalBridge;
const signalCaptures: ReturnType<typeof captureNativeSignalBridge>[] = [];
afterEach(() => {
  try {
    for (const signals of signalCaptures) {
      signals.dispose();
    }
    signalCaptures.length = 0;
  } finally {
    vi.restoreAllMocks();
  }
});
const success = () => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });
function stateFixture() {
  return { stateDir: tempDirs.make("openclaw-agent-exec-lock-") };
}
/** The --state-dir owner is this process while it holds custody. */
async function expectOwner(stateDir: string, held: boolean) {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const owner = await readActiveGatewayLockIdentity({ env, includeEmbedded: true });
  expect(owner?.pid).toBe(held ? process.pid : undefined);
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
          runExec(
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
        expect(result.envelope).toMatchObject({
          ok: false,
          status: "error",
          final: "done",
          payloads: [{ text: "done" }],
          error: { kind: "cleanup" },
        });
        expect(cleanupScope.outcome).toBe("uncertain");
        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        if (fixture) {
          await expectOwner(fixture.stateDir, true);
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

  it("holds and releases state ownership around the run", async () => {
    const { stateDir } = stateFixture();
    await fs.writeFile(path.join(stateDir, "keep.txt"), "keep");
    const result = await runExec("inspect", { stateDir }, createTestRuntime(), async () => {
      await expectOwner(stateDir, true);
      return success();
    });
    expect(result.exitCode).toBe(0);
    await expectOwner(stateDir, false);
    await expect(fs.readFile(path.join(stateDir, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it.each([
    { retained: false, signal: "SIGINT", exitCode: 130 },
    { retained: false, signal: "SIGTERM", exitCode: 143 },
    { retained: true, signal: "SIGINT", exitCode: 130 },
    { retained: true, signal: "SIGTERM", exitCode: 143 },
  ] as const)("settles state after $signal (retained: $retained)", async (testCase) => {
    const fixture = testCase.retained ? stateFixture() : undefined;
    const signals = captureNativeSignalBridge(createSignalBridge);
    signalCaptures.push(signals);
    const entered = createDeferred();
    const runtime = createTestRuntime();
    let stateDir = "";
    vi.spyOn(processSignalBridge, "createProcessSignalBridge").mockImplementationOnce(
      signals.create,
    );
    const run = runExec(
      "inspect",
      fixture ? { stateDir: fixture.stateDir } : {},
      runtime,
      async (opts) => {
        stateDir = process.env.OPENCLAW_STATE_DIR!;
        await fs.writeFile(path.join(stateDir, "keep.txt"), "keep");
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
      },
    );
    await Promise.race([
      entered.promise,
      run.then(() => {
        throw new Error("Run ended before signal admission");
      }),
    ]);
    signals.emit(testCase.signal);
    await run;
    if (fixture) {
      await expectOwner(fixture.stateDir, false);
      await expect(fs.readFile(path.join(stateDir, "keep.txt"), "utf8")).resolves.toBe("keep");
    } else {
      await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(runtime.exit).toHaveBeenCalledWith(testCase.exitCode, { resetStream: process.stderr });
  });
});

it("closes temporary databases before removal and preserves independent handles", async () => {
  const independentRoot = tempDirs.make("openclaw-agent-exec-independent-");
  const independent = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: independentRoot },
  });
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const runtime = createTestRuntime();
  let runStateDir: string | undefined;
  let agentPath: string | undefined;
  let statePath: string | undefined;
  const handles: EngineConnection[] = [];
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
    const result = await runExec("inspect", { authEnvOnly: true }, runtime, async () => {
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
      await createSqliteAuditRecordWriter({
        scope: "agent-exec-cleanup",
        maxEntries: 1,
      }).register("completed", "synthetic", 1);
      expect(
        createSqliteAuditRecordStore({ scope: "agent-exec-cleanup", maxEntries: 1 }).entries(),
      ).toEqual([{ key: "completed", value: "synthetic", createdAt: 1 }]);
      return success();
    });
    expect(result.exitCode).toBe(0);
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
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
