import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { agentDatabaseHeldRuntimeEntrypoint } from "../state/openclaw-state-lease-runtime.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
let holder: ChildProcess | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (holder && holder.exitCode === null && holder.signalCode === null) {
    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;
  }
  holder = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it("admits cold orphan repair asynchronously while a foreign native reader holds the store", async () => {
  const root = fs.realpathSync.native(roots.make("startup-orphan-admission-"));
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_SUPERVISOR_MODE: "external",
    },
    async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const scope = { agentId: "main", sessionKey: "agent:main:subagent:orphan" };
      const terminalScope = { ...scope, sessionKey: "agent:main:subagent:done" };
      const predecessor = {
        sessionId: "predecessor",
        lifecycleRevision: "generation-1",
        startedAt: Math.floor(performance.timeOrigin) - 100,
        updatedAt: Math.floor(performance.timeOrigin) - 100,
      };
      await replaceSessionEntry(scope, { ...predecessor, status: "running" });
      await replaceSessionEntry(terminalScope, {
        ...predecessor,
        sessionId: "completed",
        status: "done",
      });
      const terminal = loadSessionEntryReadOnly(terminalScope);
      const log = { info: vi.fn(), warn: vi.fn() };
      // Certify the store before closing it, as a predecessor Gateway does.
      await runStartupSessionMigration({ cfg, log });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      holder = spawn(
        process.execPath,
        [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(agentDatabaseHeldRuntimeEntrypoint)),
          "main",
          databasePath,
          root,
        ],
        {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let stderr = "";
      holder.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const child = holder;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          child.off("message", ready);
          child.off("error", failed);
          child.off("exit", exited);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const exited = () => failed(new Error(`Native reader exited before readiness: ${stderr}`));
        const ready = (message: unknown) => {
          cleanup();
          if (message === "ready") {
            resolve();
          } else {
            reject(new Error(`Unexpected native reader response: ${String(message)}`));
          }
        };
        child.once("message", ready);
        child.once("error", failed);
        child.once("exit", exited);
      });

      const integrity: string[] = [];
      const open = nodeSqlite.openNodeSqliteDatabase;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
        const database = open(pathname, options);
        if (pathname === databasePath) {
          const prepare = database.prepare.bind(database);
          vi.spyOn(database, "prepare").mockImplementation((sql) => {
            if (/PRAGMA\s+(quick_check|integrity_check)/i.test(sql)) {
              integrity.push(sql);
            }
            return prepare(sql);
          });
        }
        return database;
      });
      const lock = await acquireGatewayLock({
        allowInTests: true,
        // Lock metadata only; this fixture never starts a network listener.
        port: 24121,
        listenerMode: "foreground",
      });
      if (!lock) {
        throw new Error("expected private Gateway ownership");
      }
      try {
        await lock.run(async () => {
          await runStartupSessionMigration({ cfg, log });
          expect(loadSessionEntryReadOnly(scope)).toMatchObject({
            ...predecessor,
            status: "interrupted",
            abortedLastRun: true,
          });
          expect(loadSessionEntryReadOnly(terminalScope)).toEqual(terminal);
          expect(log.warn).not.toHaveBeenCalled();
          expect(integrity).toEqual([]);
          await runStartupSessionMigration({ cfg, log });
          const events = await loadTranscriptEvents({ ...scope, sessionId: predecessor.sessionId });
          expect(
            events.filter(
              (event) => isRecord(event) && event.customType === "run-failed-before-reply",
            ),
          ).toHaveLength(1);
        });
      } finally {
        vi.restoreAllMocks();
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        await lock.release();
        const exited = once(holder, "exit");
        holder.send("release");
        expect(await exited).toEqual([0, null]);
      }
    },
  );
});
