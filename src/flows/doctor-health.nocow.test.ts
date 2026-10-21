import "./doctor-health.test-support.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDoctorNoCowToolFixture } from "../commands/doctor-sqlite-nocow.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
  () =>
    withOpenClawTestState(
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
        setRuntimeConfigSnapshot(cfg);
        mocks.config.mockReturnValue(cfg);
        mocks.packageRoot.mockReturnValue(undefined);
        const openStores = () => [
          openOpenClawStateDatabase(),
          openOpenClawAgentDatabase({ agentId: "main" }),
        ];
        const seeded = openStores();
        for (const database of seeded) {
          database.db.exec(
            "CREATE TABLE nocow_payload(value TEXT); INSERT INTO nocow_payload VALUES ('preserved');",
          );
        }
        const paths = seeded.map((database) => database.path);
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
        await closeOpenClawStateDatabaseByPathAsync(paths[0]!);
        const originalInodes = paths.map((pathname) => fs.statSync(pathname).ino);
        let readerClosed = false;
        let handles: typeof seeded = [];
        mocks.runContributions.mockImplementationOnce(async () => {
          handles = openStores();
          await replaceSessionEntry(
            { agentId: "main", sessionKey: "agent:main:nocow", env: state.env },
            { sessionId: "doctor-nocow", updatedAt: 1 },
          );
          const location = await runSqliteReadOnlyWorker(paths[1]!, { mode: "sync" });
          expect(await adoptPreparedLocation(location).cleanupAsync()).toBe(true);
          const children = vi.mocked(spawn).mock.results.flatMap((result) => {
            const child = result.type === "return" ? result.value : undefined;
            const args = child?.spawnargs ?? [];
            const marker = args.indexOf(SQLITE_READONLY_CHILD_ARG);
            return marker >= 0 &&
              args[marker + 1] === "session" &&
              child?.exitCode === null &&
              child.signalCode === null
              ? [child]
              : [];
          });
          expect(children).toHaveLength(1);
          const reader = children[0]!;
          reader.once("close", () => {
            readerClosed = true;
          });
          expect(handles.every((database) => database.db.isOpen)).toBe(true);
        });
        tools.beforeExchange = () => {
          expect(readerClosed).toBe(true);
          expect(handles.every((database) => !database.db.isOpen)).toBe(true);
        };
        const log = vi.fn();
        await runDoctorHealthFlow(
          { log, error: vi.fn(), exit: vi.fn() },
          { repair: true, nonInteractive: true, workspaceSuggestions: false },
        );
        expect(readerClosed).toBe(true);
        const rewrites = log.mock.calls
          .flat()
          .filter(
            (message) =>
              typeof message === "string" && message.startsWith("Rewrote SQLite files with NOCOW:"),
          );
        expect(rewrites).toEqual(
          paths.map((pathname) => expect.stringContaining(path.dirname(pathname))),
        );
        expect(log.mock.calls.flat().join("\n")).not.toContain("SQLite NOCOW repair refused");
        for (const [index, pathname] of paths.entries()) {
          expect(fs.statSync(pathname).ino).not.toBe(originalInodes[index]);
          using database = openNodeSqliteDatabase(pathname, { readOnly: true });
          expect(database.prepare("SELECT value FROM nocow_payload").get()).toMatchObject({
            value: "preserved",
          });
        }
      },
    ),
);
