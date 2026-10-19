import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  createTranscriptEventReader,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";
import { jsonl, messageEvent, expectIssue } from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
} from "./doctor-session-sqlite.js";
import {
  expectFiles,
  expectMissing,
  containsObjects,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import { expectNoIssue } from "./doctor-session-sqlite.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const pluginId = "session-fixture";
type History =
  | "equal"
  | "sqlite-ahead"
  | "sqlite-subset"
  | "opaque"
  | "missing-delta"
  | "missing-middle"
  | "invalid"
  | "clean";

function transcriptEvents(sessionId: string): Array<Record<string, unknown> & { id: string }> {
  return [
    { type: "session", version: 3, id: sessionId },
    messageEvent(`${sessionId}-user`, "user", "Retained June history"),
    {
      type: "message",
      id: `${sessionId}-assistant`,
      parentId: `${sessionId}-user`,
      message: { role: "assistant", content: [{ type: "text", text: "Original response" }] },
    },
  ];
}

async function seedImportedHistory(
  state: OpenClawTestState,
  scenarios: Readonly<Record<string, History>>,
  pendingPlugin = true,
) {
  const cfg: OpenClawConfig = {
    agents: { entries: Object.fromEntries(Object.keys(scenarios).map((id) => [id, {}])) },
  };
  const sessions = [];
  for (const [agentId, history] of Object.entries(scenarios)) {
    const directory = state.sessionsDir(agentId);
    fs.mkdirSync(directory, { recursive: true });
    const storePath = path.join(directory, "sessions.json");
    fs.writeFileSync(storePath, "{}");
    const sessionId = `${agentId}-june`;
    const scope = { agentId, env: state.env, storePath, sessionKey: `agent:${agentId}:june` };
    const original = transcriptEvents(sessionId);
    if (history === "opaque") {
      original.push({ type: "future_event", id: `${sessionId}-opaque`, payload: "preserved" });
    }
    if (history === "missing-delta") {
      for (const id of ["four", "five"]) {
        original.push(messageEvent(`${sessionId}-${id}`, "user", id, original.at(-1)!.id));
      }
    }
    const canonical =
      history === "missing-delta"
        ? original.slice(0, 3)
        : history === "missing-middle"
          ? [original[0]!, original[2]!]
          : [...original];
    if (history === "sqlite-ahead") {
      while (canonical.length < 95) {
        const id = `${sessionId}-newer-${canonical.length}`;
        canonical.push(messageEvent(id, "user", "SQLite-only", canonical.at(-1)!.id));
      }
    }
    if (history === "sqlite-subset") {
      canonical.splice(1, 2, original[2]!, original[1]!);
    }
    const sourcePath = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(sourcePath, jsonl(...canonical));
    await importSqliteSessionRowsBatch([
      {
        ...scope,
        entry: { sessionId, updatedAt: 123456, label: "Operator's current session label" },
        readTranscriptEvents: createTranscriptEventReader(sourcePath, sessionId),
      },
    ]);
    fs.unlinkSync(sourcePath);
    const sourceEvents = [...original];
    if (history === "invalid") {
      sourceEvents[0] = { type: "session", version: 3, id: "another-session" };
    }
    sessions.push({
      ...scope,
      history,
      sessionId,
      canonical: loadTranscriptEventsSync({ ...scope, sessionId }),
      sourceEvents,
      sourcePath,
      bytes: Buffer.from(jsonl(...sourceEvents)),
      entryBefore: loadExactSessionEntry(scope)?.entry,
    });
  }
  if (pendingPlugin) {
    await recordDeferredPluginMigrations({
      env: state.env,
      pending: [{ pluginId, reason: "Plugin migration pending", command: "openclaw doctor --fix" }],
    });
    // The later plugin receipt does not know about June's already-imported originals.
    await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
  }
  for (const session of sessions) {
    if (session.history !== "clean") {
      fs.writeFileSync(session.sourcePath, session.bytes);
    }
  }
  const options = { cfg, env: state.env, allAgents: true };
  const run = (mode: DoctorSessionSqliteMode = "import") =>
    runDoctorSessionSqlite({ ...options, mode });
  const settle = (mode: DoctorSessionSqliteMode = "import") =>
    withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "settle retained originals",
      run: async (authority) => {
        const report = await run(mode);
        await settleRetainedDoctorSessionSources(report, [pluginId], authority, () =>
          authority.assertCurrent(),
        );
        return report;
      },
    });
  return { sessions, run, settle };
}

type ImportedHistory = Awaited<ReturnType<typeof seedImportedHistory>>;
function withHistory(
  scenarios: Readonly<Record<string, History>>,
  pendingPlugin: boolean,
  run: (fixture: ImportedHistory, state: OpenClawTestState) => Promise<void>,
) {
  return withOpenClawTestState({ label: "active-settlement" }, async (state) =>
    run(await seedImportedHistory(state, scenarios, pendingPlugin), state),
  );
}

function expectUnchanged(session: ImportedHistory["sessions"][number]) {
  expect(loadExactSessionEntry(session)?.entry).toEqual(session.entryBefore);
  expect(loadTranscriptEventsSync(session)).toEqual(session.canonical);
}

function completedTranscriptMoves(state: OpenClawTestState, sourcePath: string) {
  return listSessionSqliteMigrationManifestPaths(state.env).flatMap((filename) =>
    (readSessionSqliteMigrationManifest(filename)?.targets ?? []).flatMap((target) =>
      target.completedMoves.filter((move) => move.sourcePath === sourcePath),
    ),
  );
}

it.each([
  { mode: "import", pendingPlugin: true },
  { mode: "recover", pendingPlugin: true },
  { mode: "import", pendingPlugin: false },
  { mode: "recover", pendingPlugin: false },
] as const)(
  "$mode settles imported originals without replacing current sessions (plugin receipt=$pendingPlugin)",
  async ({ mode, pendingPlugin }) => {
    await withHistory(
      pendingPlugin
        ? {
            main: "equal",
            diana: "sqlite-ahead",
            frieren: "missing-delta",
            subset: "sqlite-subset",
            opaque: "opaque",
          }
        : { main: "sqlite-ahead" },
      pendingPlugin,
      async ({ sessions, run, settle }, state) => {
        const duplicateArchives: string[] = [];
        const duplicateBytes = jsonl(...transcriptEvents("unrelated-history"));
        if (pendingPlugin && mode === "import") {
          const target = {
            agentId: "main",
            storePath: sessions[0]!.storePath,
            sqlitePath: resolveTargetSqlitePath(sessions[0]!, state.env),
          };
          const archiveDir = path.join(
            path.dirname(state.sessionsDir()),
            "session-sqlite-import-archive",
          );
          fs.mkdirSync(archiveDir, { recursive: true });
          const old = createSessionSqliteMigrationRun(state.env, [target]);
          for (const copy of [1, 2]) {
            const archivePath = path.join(archiveDir, `unrelated-history.jsonl.imported-${copy}`);
            fs.writeFileSync(archivePath, duplicateBytes);
            duplicateArchives.push(archivePath);
            const move: SessionSqliteMigrationMove = {
              kind: "unreferenced-jsonl",
              sourcePath: path.join(state.sessionsDir(), "unrelated-history.jsonl"),
              archivePath,
              artifact: {
                identity: readMigrationArtifactIdentity(archivePath),
                classification: "protected",
                reason: "unreferenced-history",
                dependencies: [],
                disposal: { state: "retained" },
              },
            };
            recordPlannedMigrationMoves(old, target, [move]);
            recordCompletedMigrationMoves(old, target, [move]);
          }
          updateMigrationManifestTarget(old, target, [], { validationBeforeArchive: "passed" });
          old.manifest.completedAt = old.manifest.startedAt;
          writeSessionSqliteMigrationManifest(old);
        }
        const report = await (pendingPlugin ? settle(mode) : run(mode));
        if (pendingPlugin) {
          expect(report.totals.importedTranscriptEvents).toBe(2);
        } else {
          expect(report.totals.issues).toBe(0);
          expect(report.supportIssue).toBeUndefined();
        }
        expectNoIssue(report, "active_sqlite_transcript_jsonl");
        if (pendingPlugin && mode === "import") {
          expect(report.targets.flatMap((target) => target.issues)).toEqual([
            {
              code: "historical_duplicate_settled",
              message: expect.stringContaining("Retired 1 byte-identical duplicate archive(s)"),
            },
          ]);
          const survivingArchives = duplicateArchives.filter((file) => fs.existsSync(file));
          expect(survivingArchives).toHaveLength(1);
          expectFiles(duplicateBytes, survivingArchives[0]!);
          for (const session of sessions) {
            expectMissing(session.storePath);
            const indexes = completedTranscriptMoves(state, session.storePath);
            expect(indexes).toHaveLength(1);
            expect(indexes[0]!.artifact?.classification).toBe("imported");
            expectFiles("{}", indexes[0]!.archivePath);
          }
        }
        for (const session of sessions) {
          expectMissing(session.sourcePath);
          const moves = completedTranscriptMoves(state, session.sourcePath);
          expect(moves).toHaveLength(1);
          expectFiles(session.bytes, moves[0]!.archivePath);
          expect(moves[0]!.artifact?.verification).toBe(
            pendingPlugin
              ? `superseded by SQLite (${session.sourceEvents.length} of ${Math.max(session.canonical.length, session.sourceEvents.length)} events present)`
              : "superseded by SQLite (3 of 95 events present)",
          );
          expect(loadExactSessionEntry(session)?.entry).toEqual(session.entryBefore);
          expect(loadTranscriptEventsSync(session)).toEqual(
            session.history === "missing-delta" ? session.sourceEvents : session.canonical,
          );
        }
        if (!pendingPlugin) {
          const session = sessions[0]!;
          const moves = completedTranscriptMoves(state, session.sourcePath);
          const repeated = await run(mode);
          expect(repeated.totals).toMatchObject({
            issues: 0,
            importedTranscriptEvents: 0,
            archivedTranscriptFiles: 0,
          });
          expect(repeated.supportIssue).toBeUndefined();
          expect(completedTranscriptMoves(state, session.sourcePath)).toEqual(moves);
        }
      },
    );
  },
);

it.each(["missing-middle", "invalid"] as const)(
  "preserves %s history on failed settlement",
  async (history) => {
    const pendingPlugin = history === "invalid";
    await withHistory(
      pendingPlugin ? { main: history, frieren: "clean" } : { main: history },
      pendingPlugin,
      async ({ sessions, run }, state) => {
        const main = sessions.find((session) => session.agentId === "main")!;
        await withDoctorSqliteMaintenanceLock({
          env: state.env,
          operation: "verify per-agent settlement",
          run: async (authority) => {
            const report = await run();
            if (pendingPlugin) {
              try {
                await settleRetainedDoctorSessionSources(report, [pluginId], authority, () =>
                  authority.assertCurrent(),
                );
              } catch (error) {
                expect(String(error)).toContain(main.sourcePath);
              }
              const clean = report.targets.find((target) => target.agentId === "frieren")!;
              expect(
                clean.issues.filter((issue) => issue.code !== "plugin_migration_source_retained"),
              ).toEqual([]);
              const failed = report.targets.find((target) => target.agentId === "main")!;
              containsObjects(failed.issues, {
                code: "active_sqlite_transcript_verification_failed",
                sessionKey: main.sessionKey,
                message: expect.stringContaining(main.sourcePath),
              });
            } else {
              expectIssue(report, {
                code: "sqlite_transcript_count_mismatch",
                message: expect.stringContaining(`${main.sessionId}-user`),
              });
            }
            expectFiles(main.bytes, main.sourcePath);
            expect(completedTranscriptMoves(state, main.sourcePath)).toEqual([]);
            sessions.forEach(expectUnchanged);
          },
        });
      },
    );
  },
);
