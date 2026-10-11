import "./doctor-health.test-support.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDoctorNoCowToolFixture } from "../commands/doctor-sqlite-nocow.test-support.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { adoptPreparedLocation } from "../infra/sqlite-readonly-location-cleanup.js";
import { runSqliteReadOnlyWorker } from "../infra/sqlite-readonly-worker.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("../infra/sqlite-wal-filesystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-wal-filesystem.js")>()),
  isSqlitePathOnBtrfs: vi.fn(() => true),
  setSqliteDirectoryNoCow: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform !== "linux")(
  "joins Doctor's inspection child and database handles before rewriting both stores",
  async () => {
    await withOpenClawTestState(
      {
        scenario: "external-service",
        label: "doctor-health-nocow",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_DOCTOR_SQLITE_NOCOW_REPAIR: "1",
        },
      },
      async (state) => {
        const native =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        const tools = createDoctorNoCowToolFixture(state.root, native.spawnSync);
        const cfg = {
          agents: {
            ownership: "explicit" as const,
            entries: { main: { workspace: state.workspaceDir } },
          },
          gateway: { mode: "local" as const },
        };
        await state.writeConfig(cfg);
        mocks.config.mockReturnValue(cfg);
        mocks.packageRoot.mockReturnValue(undefined);
        const seeded = [
          openOpenClawStateDatabase(),
          openOpenClawAgentDatabase({ agentId: "main" }),
        ];
        for (const database of seeded) {
          database.db.exec(
            "CREATE TABLE nocow_payload(value TEXT); INSERT INTO nocow_payload VALUES ('preserved');",
          );
        }
        const paths = seeded.map((database) => database.path);
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
        await closeOpenClawStateDatabaseByPathAsync(paths[0]!);
        const originalInodes = paths.map((pathname) => fs.statSync(pathname).ino);
        let reader: ChildProcess | undefined;
        let readerClosed = false;
        let handles: typeof seeded = [];
        mocks.runContributions.mockImplementationOnce(async () => {
          handles = [openOpenClawStateDatabase(), openOpenClawAgentDatabase({ agentId: "main" })];
          await replaceSessionEntry(
            { agentId: "main", sessionKey: "agent:main:nocow", env: state.env },
            { sessionId: "doctor-nocow", updatedAt: 1 },
          );
          const location = await runSqliteReadOnlyWorker(paths[1]!, { mode: "sync" });
          expect(await adoptPreparedLocation(location).cleanupAsync()).toBe(true);
          const children = vi.mocked(spawn).mock.calls.flatMap(([, args], index) => {
            if (!Array.isArray(args)) {
              return [];
            }
            const marker = args.indexOf(SQLITE_READONLY_CHILD_ARG);
            const spawned = vi.mocked(spawn).mock.results[index];
            const child = spawned?.type === "return" ? spawned.value : undefined;
            return marker >= 0 &&
              args[marker + 1] === "session" &&
              child?.exitCode === null &&
              child.signalCode === null
              ? [child]
              : [];
          });
          expect(children).toHaveLength(1);
          reader = children[0]!;
          reader.once("close", () => {
            readerClosed = true;
          });
          expect(handles.every((database) => database.db.isOpen)).toBe(true);
        });
        tools.beforeExchange = () => {
          expect(reader).toBeDefined();
          expect(readerClosed).toBe(true);
          expect(handles.every((database) => !database.db.isOpen)).toBe(true);
        };
        const log = vi.fn();
        await runDoctorHealthFlow(
          { log, error: vi.fn(), exit: vi.fn() },
          { repair: true, nonInteractive: true, workspaceSuggestions: false },
        );
        expect(readerClosed).toBe(true);
        expect(tools.exchanges).toBe(2);
        expect(log.mock.calls.flat().join("\n")).not.toContain("SQLite NOCOW repair refused");
        for (const [index, pathname] of paths.entries()) {
          expect(fs.statSync(pathname).ino).not.toBe(originalInodes[index]);
          const database = openNodeSqliteDatabase(pathname, { readOnly: true });
          try {
            expect(database.prepare("SELECT value FROM nocow_payload").get()?.value).toBe(
              "preserved",
            );
          } finally {
            database.close();
          }
        }
      },
    );
  },
);
