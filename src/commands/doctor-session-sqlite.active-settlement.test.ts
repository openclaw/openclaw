import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "./doctor-session-sqlite-migration-run.js";
import { createTranscriptEventReader } from "./doctor-session-sqlite-readers.js";
import {
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
} from "./doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const pluginId = "session-fixture";
type History =
  | "equal"
  | "sqlite-ahead"
  | "missing-delta"
  | "missing-middle"
  | "changed-content"
  | "invalid"
  | "clean";

function transcriptEvents(sessionId: string): TranscriptEvent[] {
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
    const canonical =
      history === "missing-delta"
        ? original.slice(0, 2)
        : history === "missing-middle"
          ? [original[0]!, original[2]!]
          : [...original];
    if (history === "sqlite-ahead") {
      canonical.push({
        type: "message",
        id: `${sessionId}-newer`,
        parentId: `${sessionId}-assistant`,
        message: { role: "user", content: "New SQLite-only conversation" },
      });
    }
    const sourcePath = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(sourcePath, canonical.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await importSqliteSessionRowsBatch([
      {
        ...scope,
        entry: { sessionId, updatedAt: 123456, label: "Operator's current session label" },
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
  recordDeferredPluginMigrations({
    env: state.env,
    pending: [{ pluginId, reason: "Plugin migration pending", command: "openclaw doctor --fix" }],
  });
  // The later plugin receipt does not know about June's already-imported originals.
  await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
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

it.each(["import", "recover"] as const)(
  "%s settles already-imported June originals and missing deltas without replacing current sessions",
  async (mode) => {
    await withOpenClawTestState({ label: `active-june-${mode}` }, async (state) => {
      const { cfg, sessions } = await seedImportedHistory(state, {
        main: "equal",
        diana: "sqlite-ahead",
        frieren: "missing-delta",
      });
      await withDoctorSqliteMaintenanceLock({
        env: state.env,
        operation: "settle June originals",
        run: async (authority) => {
          const report = await runDoctorSessionSqlite({
            cfg,
            env: state.env,
            allAgents: true,
            mode,
          });
          await settleRetainedDoctorSessionSources(report, [pluginId], authority, () =>
            authority.assertCurrent(),
          );
          expect(report.targets.flatMap((target) => target.issues)).not.toContainEqual(
            expect.objectContaining({ code: "active_sqlite_transcript_jsonl" }),
          );
          for (const session of sessions) {
            expect(fs.existsSync(session.sourcePath)).toBe(false);
            const moves = completedTranscriptMoves(state, session.sourcePath);
            expect(moves).toHaveLength(1);
            expect(fs.readFileSync(moves[0]!.archivePath)).toEqual(session.bytes);
            expect(loadExactSessionEntry(session)?.entry).toEqual(session.entryBefore);
            expect(loadTranscriptEventsSync(session)).toEqual(
              session.history === "missing-delta" ? session.sourceEvents : session.canonical,
            );
          }
        },
      });
    });
  },
);

it.each(["changed-content", "missing-middle"] as const)(
  "preserves conflicting history without committing an invalid merge (%s)",
  async (history) => {
    await withOpenClawTestState({ label: "active-june-content" }, async (state) => {
      const {
        cfg,
        sessions: [session],
      } = await seedImportedHistory(state, { main: history });
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
          await expect(
            settleRetainedDoctorSessionSources(report, [pluginId], authority, () =>
              authority.assertCurrent(),
            ),
          ).rejects.toThrow(session!.sourcePath);
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
