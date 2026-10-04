import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  readMigrationArtifactIdentity,
  moveMigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

it.each([
  { deletionState: "complete", deleteFiles: true, restores: false },
  { deletionState: "pending", deleteFiles: true, restores: false },
  { deletionState: "absent", deleteFiles: true, restores: true },
] as const)(
  "respects $deletionState delete-files tombstone during automatic archive import",
  async ({ deletionState, deleteFiles, restores }) => {
    await withOpenClawTestState({ label: "doctor-deleted-archive" }, async (state) => {
      const cfg = { agents: { entries: { main: { default: true } } } };
      const agentId = "second_coder";
      const archive = state.statePath("agents", agentId, "session-sqlite-import-archive");
      fs.mkdirSync(archive, { recursive: true });
      const artifact = path.join(archive, "session.jsonl.imported-1");
      const bytes =
        [
          {
            type: "session",
            id: "session",
            version: 3,
            timestamp: "2026-06-15T00:00:00.000Z",
            cwd: "/legacy/workspace",
          },
          {
            type: "message",
            id: "user",
            parentId: null,
            timestamp: "2026-06-15T00:00:01.000Z",
            message: { role: "user", content: "Retired history" },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n";
      fs.mkdirSync(state.sessionsDir(agentId), { recursive: true });
      const sourcePath = path.join(state.sessionsDir(agentId), "session.jsonl");
      fs.writeFileSync(sourcePath, bytes);
      const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
      const target = {
        agentId,
        storePath,
        sqlitePath: resolveTargetSqlitePath({ agentId, storePath }, state.env),
      };
      const run = createSessionSqliteMigrationRun(state.env, [target]);
      const move: SessionSqliteMigrationMove = {
        kind: "unreferenced-jsonl",
        sourcePath,
        archivePath: artifact,
        artifact: {
          identity: readMigrationArtifactIdentity(sourcePath),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        },
      };
      recordPlannedMigrationMoves(run, target, [move]);
      await moveMigrationArtifact(sourcePath, artifact, move.artifact!.identity);
      recordCompletedMigrationMoves(run, target, [move]);
      updateMigrationManifestTarget(run, target, [], { validationBeforeArchive: "passed" });
      run.manifest.completedAt = new Date().toISOString();
      writeSessionSqliteMigrationManifest(run);
      fs.rmdirSync(state.sessionsDir(agentId));
      fs.writeFileSync(state.statePath("agents", agentId, ".DS_Store"), "retained artifact");
      if (deletionState !== "absent") {
        beginAgentDeletionJournal(
          {
            agentId,
            operationId: "delete-second-coder",
            deleteFiles,
            agentDir: state.agentDir(agentId),
            sessionsDir: state.sessionsDir(agentId),
            workspaceDir: state.workspaceDir,
          },
          { env: state.env },
        );
      }
      if (deletionState === "complete") {
        runOpenClawStateWriteTransaction(
          (database) => {
            expect(
              completeAgentDeletionJournalInDatabase(database, agentId, "delete-second-coder"),
            ).toBe(true);
          },
          { env: state.env },
        );
      }
      const deletion = readAgentDeletionJournal(agentId, { env: state.env });

      const repair = noteSessionTranscriptHealth({ cfg, env: state.env, shouldRepair: true });
      if (deletionState === "pending") {
        await expect(repair).rejects.toThrow("agent second_coder is deleted");
      } else {
        await expect(repair).resolves.toBeUndefined();
      }

      expect(fs.readFileSync(artifact, "utf8")).toBe(bytes);
      expect(fs.existsSync(target.sqlitePath)).toBe(restores);
      if (deletionState === "complete") {
        expect(fs.existsSync(state.agentDir(agentId))).toBe(false);
        expect(fs.existsSync(state.sessionsDir(agentId))).toBe(false);
      }
      expect(readAgentDeletionJournal(agentId, { env: state.env })).toEqual(deletion);
      expect(Object.keys(cfg.agents.entries)).toEqual(["main"]);
    });
  },
);
