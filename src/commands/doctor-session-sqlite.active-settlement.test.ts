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
import {
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
} from "./doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const pluginId = "session-fixture";
type History =
  | "equal"
  | "sqlite-ahead"
  | "sqlite-subset"
  | "opaque"
  | "missing-delta"
  | "missing-middle"
  | "changed-content"
  | "array-order-conflict"
  | "legacy-codex-metadata"
  | "invalid"
  | "clean";

function transcriptEvents(sessionId: string): Array<Record<string, unknown> & { id: string }> {
  return [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-06-01T00:00:00.000Z",
      cwd: "/synthetic-june-workspace",
    },
    {
      type: "message",
      id: `${sessionId}-user`,
      parentId: null,
      message: { role: "user", content: "Retained June history" },
    },
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
        original.push({
          type: "message",
          id: `${sessionId}-${id}`,
          parentId: original.at(-1)!.id,
          message: { role: "user", content: id },
        });
      }
    }
    if (history === "array-order-conflict") {
      original[2] = {
        type: "message",
        id: `${sessionId}-assistant`,
        parentId: `${sessionId}-user`,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First ordered part" },
            { type: "text", text: "Second ordered part" },
          ],
        },
      };
    }
    if (history === "legacy-codex-metadata") {
      original[2] = {
        type: "message",
        id: `${sessionId}-assistant`,
        parentId: `${sessionId}-user`,
        message: {
          role: "assistant",
          provider: "codex",
          api: "openai-codex-responses",
          content: [{ type: "text", text: "Lorem ipsum" }],
        },
      };
    }
    const canonical =
      history === "missing-delta"
        ? original.slice(0, 3)
        : history === "missing-middle"
          ? [original[0]!, original[2]!]
          : [...original];
    if (history === "sqlite-ahead") {
      while (canonical.length < 95) {
        canonical.push({
          type: "message",
          id: `${sessionId}-newer-${canonical.length}`,
          parentId: canonical.at(-1)!.id,
          message: { role: "user", content: "New SQLite-only conversation" },
        });
      }
    }
    if (history === "sqlite-subset") {
      canonical.splice(1, 2, original[2]!, original[1]!);
    }
    const sourcePath = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(sourcePath, canonical.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await importSqliteSessionRowsBatch([
      {
        ...scope,
        entry: { sessionId, updatedAt: 123456, label: "Operator's current session label" },
        repairLegacyTranscript: history === "legacy-codex-metadata",
        readTranscriptEvents: createTranscriptEventReader(sourcePath, sessionId),
      },
    ]);
    fs.unlinkSync(sourcePath);
    const sourceEvents = [...original];
    if (history === "changed-content") {
      sourceEvents[2] = {
        type: "message",
        id: `${sessionId}-assistant`,
        parentId: `${sessionId}-user`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Different content with the same event ID" }],
        },
      };
    }
    if (history === "array-order-conflict") {
      sourceEvents[2] = {
        type: "message",
        id: `${sessionId}-assistant`,
        parentId: `${sessionId}-user`,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Second ordered part" },
            { type: "text", text: "First ordered part" },
          ],
        },
      };
    }
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
      bytes: Buffer.from(sourceEvents.map((event) => JSON.stringify(event)).join("\n") + "\n"),
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
  return { cfg, sessions };
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
    await withOpenClawTestState({ label: `active-june-${mode}` }, async (state) => {
      const { cfg, sessions } = await seedImportedHistory(
        state,
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
      );
      const options = { cfg, env: state.env, allAgents: true, mode };
      const duplicateArchives: string[] = [];
      const duplicateBytes =
        transcriptEvents("unrelated-history")
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n";
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
      const report = pendingPlugin
        ? await withDoctorSqliteMaintenanceLock({
            env: state.env,
            operation: "settle June originals",
            run: async (authority) => {
              const settled = await runDoctorSessionSqlite(options);
              await settleRetainedDoctorSessionSources(settled, [pluginId], authority, () =>
                authority.assertCurrent(),
              );
              return settled;
            },
          })
        : await runDoctorSessionSqlite(options);
      if (pendingPlugin) {
        expect(report.totals.importedTranscriptEvents).toBe(2);
      } else {
        expect(report.totals.issues).toBe(0);
        expect(report.supportIssue).toBeUndefined();
      }
      expect(report.targets.flatMap((target) => target.issues)).not.toContainEqual(
        expect.objectContaining({ code: "active_sqlite_transcript_jsonl" }),
      );
      if (pendingPlugin && mode === "import") {
        expect(report.targets.flatMap((target) => target.issues)).toEqual([
          {
            code: "historical_duplicate_settled",
            message: expect.stringContaining("Retired 1 byte-identical duplicate archive(s)"),
          },
        ]);
        const survivingArchives = duplicateArchives.filter((file) => fs.existsSync(file));
        expect(survivingArchives).toHaveLength(1);
        expect(fs.readFileSync(survivingArchives[0]!, "utf8")).toBe(duplicateBytes);
        for (const session of sessions) {
          expect(fs.existsSync(session.storePath)).toBe(false);
          const indexes = completedTranscriptMoves(state, session.storePath);
          expect(indexes).toHaveLength(1);
          expect(indexes[0]!.artifact?.classification).toBe("imported");
          expect(fs.readFileSync(indexes[0]!.archivePath, "utf8")).toBe("{}");
        }
      }
      for (const session of sessions) {
        expect(fs.existsSync(session.sourcePath)).toBe(false);
        const moves = completedTranscriptMoves(state, session.sourcePath);
        expect(moves).toHaveLength(1);
        expect(fs.readFileSync(moves[0]!.archivePath)).toEqual(session.bytes);
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
        const repeated = await runDoctorSessionSqlite(options);
        expect(repeated.totals).toMatchObject({
          issues: 0,
          importedTranscriptEvents: 0,
          archivedTranscriptFiles: 0,
        });
        expect(repeated.supportIssue).toBeUndefined();
        expect(completedTranscriptMoves(state, session.sourcePath)).toEqual(moves);
      }
    });
  },
);

it.each(["import", "recover"] as const)(
  "%s retires a legacy Codex transcript whose only SQLite differences are normalized provider metadata",
  async (mode) => {
    await withOpenClawTestState({ label: `active-june-legacy-codex-${mode}` }, async (state) => {
      const {
        cfg,
        sessions: [session],
      } = await seedImportedHistory(state, { main: "legacy-codex-metadata" }, false);

      const report = await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode });

      expect(report.totals).toMatchObject({ issues: 0, importedTranscriptEvents: 0 });
      expect(fs.existsSync(session!.sourcePath)).toBe(false);
      const [move] = completedTranscriptMoves(state, session!.sourcePath);
      expect(fs.readFileSync(move!.archivePath)).toEqual(session!.bytes);
      expect(loadTranscriptEventsSync(session!)[2]).toMatchObject({
        id: `${session!.sessionId}-assistant`,
        message: expect.objectContaining({
          provider: "openai",
          api: "openai-chatgpt-responses",
          content: [{ type: "text", text: "Lorem ipsum" }],
        }),
      });
    });
  },
);

it.each(["import", "recover"] as const)(
  "%s keeps a legacy Codex transcript when content changes alongside normalizable metadata",
  async (mode) => {
    await withOpenClawTestState(
      { label: `active-june-legacy-codex-conflict-${mode}` },
      async (state) => {
        const {
          cfg,
          sessions: [session],
        } = await seedImportedHistory(state, { main: "legacy-codex-metadata" }, false);
        const conflictingEvents = session!.sourceEvents.map((event) => {
          if (event.id !== `${session!.sessionId}-assistant`) {
            return event;
          }
          return Object.assign({}, event, {
            message: {
              role: "assistant",
              provider: "codex",
              api: "openai-codex-responses",
              content: [{ type: "text", text: "Lorem ipsum altered" }],
            },
          });
        });
        const conflictingBytes = Buffer.from(
          conflictingEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
        );
        fs.writeFileSync(session!.sourcePath, conflictingBytes);

        const report = await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode });

        expect(report.totals.importedTranscriptEvents).toBe(0);
        expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining(
              "conflicts with the SQLite event of the same identity",
            ),
          }),
        );
        expect(fs.readFileSync(session!.sourcePath)).toEqual(conflictingBytes);
        expect(completedTranscriptMoves(state, session!.sourcePath)).toEqual([]);
      },
    );
  },
);

it.each(["import", "recover"] as const)("%s rejects an array-order change", async (mode) => {
  await withOpenClawTestState({ label: `active-june-semantic-array-${mode}` }, async (state) => {
    const {
      cfg,
      sessions: [session],
    } = await seedImportedHistory(state, { main: "array-order-conflict" });
    await withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "reject semantic array-order conflict",
      run: async () => {
        const report = await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode });
        expect(report.totals.importedTranscriptEvents).toBe(0);
        expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({ code: "active_sqlite_transcript_verification_failed" }),
        );
        expect(loadTranscriptEventsSync(session!)).toEqual(session!.canonical);
        expect(fs.readFileSync(session!.sourcePath)).toEqual(session!.bytes);
        expect(completedTranscriptMoves(state, session!.sourcePath)).toEqual([]);
      },
    });
  });
});

it.each(["import", "recover"] as const)(
  "%s rejects a same-ID event with changed parent and nested payload",
  async (mode) => {
    await withOpenClawTestState({ label: `active-june-semantic-id-${mode}` }, async (state) => {
      const {
        cfg,
        sessions: [session],
      } = await seedImportedHistory(state, { main: "equal" });
      const conflictingEvents = session!.sourceEvents.map((event) =>
        event.id === `${session!.sessionId}-assistant`
          ? {
              type: "message",
              id: event.id,
              parentId: `${session!.sessionId}-different-parent`,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Changed nested payload" }],
              },
            }
          : event,
      );
      const conflictingBytes = Buffer.from(
        conflictingEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
      fs.writeFileSync(session!.sourcePath, conflictingBytes);
      await withDoctorSqliteMaintenanceLock({
        env: state.env,
        operation: "reject semantic same-ID conflict",
        run: async () => {
          const report = await runDoctorSessionSqlite({
            cfg,
            env: state.env,
            allAgents: true,
            mode,
          });
          expect(report.totals.importedTranscriptEvents).toBe(0);
          expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
            expect.objectContaining({
              code: "active_sqlite_transcript_verification_failed",
              message: expect.stringContaining(
                "conflicts with the SQLite event of the same identity",
              ),
            }),
          );
          expect(loadTranscriptEventsSync(session!)).toEqual(session!.canonical);
          expect(fs.readFileSync(session!.sourcePath)).toEqual(conflictingBytes);
          expect(completedTranscriptMoves(state, session!.sourcePath)).toEqual([]);
        },
      });
    });
  },
);

it.each([
  { history: "changed-content", pendingPlugin: true },
  { history: "missing-middle", pendingPlugin: false },
] as const)(
  "preserves $history without committing an invalid merge (plugin receipt=$pendingPlugin)",
  async ({ history, pendingPlugin }) => {
    await withOpenClawTestState({ label: "active-june-content" }, async (state) => {
      const {
        cfg,
        sessions: [session],
      } = await seedImportedHistory(state, { main: history }, pendingPlugin);
      expect(session).toBeDefined();
      await withDoctorSqliteMaintenanceLock({
        env: state.env,
        operation: "settle changed June content",
        run: async (authority) => {
          const report = await runDoctorSessionSqlite({
            cfg,
            env: state.env,
            allAgents: true,
            mode: "import",
          });
          if (pendingPlugin) {
            await expect(
              settleRetainedDoctorSessionSources(report, [pluginId], authority, () =>
                authority.assertCurrent(),
              ),
            ).rejects.toThrow(session!.sourcePath);
          }
          expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
            expect.objectContaining({
              code: pendingPlugin
                ? "active_sqlite_transcript_verification_failed"
                : "sqlite_transcript_count_mismatch",
              message: expect.stringContaining(
                `${session!.sessionId}-${history === "changed-content" ? "assistant" : "user"}`,
              ),
            }),
          );
          const events = loadTranscriptEventsSync(session!);
          expect(events).toEqual(session!.canonical);
          expect(loadExactSessionEntry(session!)?.entry).toEqual(session!.entryBefore);
          expect(fs.readFileSync(session!.sourcePath)).toEqual(session!.bytes);
          const moves = completedTranscriptMoves(state, session!.sourcePath);
          expect(moves).toEqual([]);
        },
      });
    });
  },
);

it("preserves an invalid main transcript without assigning its failure to a clean agent", async () => {
  await withOpenClawTestState({ label: "active-june-agent-scope" }, async (state) => {
    const { cfg, sessions } = await seedImportedHistory(state, {
      main: "invalid",
      frieren: "clean",
    });
    const main = sessions.find((session) => session.agentId === "main")!;
    await withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "verify per-agent June settlement",
      run: async (authority) => {
        const report = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
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
        expect(failed.issues).toContainEqual(
          expect.objectContaining({
            code: "active_sqlite_transcript_verification_failed",
            sessionKey: main.sessionKey,
            message: expect.stringContaining(main.sourcePath),
          }),
        );
        expect(fs.readFileSync(main.sourcePath)).toEqual(main.bytes);
        expect(completedTranscriptMoves(state, main.sourcePath)).toEqual([]);
        for (const session of sessions) {
          expect(loadExactSessionEntry(session)?.entry).toEqual(session.entryBefore);
          expect(loadTranscriptEventsSync(session)).toEqual(session.canonical);
        }
      },
    });
  });
});
