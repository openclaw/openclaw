import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it.each(["valid", "retired", "unrelated"])(
  "leaves a completed deleted store out of startup projection with %s path history",
  async (malformed) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      const activeKey = "agent:main:active";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: activeKey },
        { sessionId: "active", updatedAt: 1 },
      );
      const retainedPath = createLegacyDatabaseFixture({
        agentId: "retired",
        env: process.env,
        eventsBySession: {},
        schemaVersion: 19,
      });
      beginAgentDeletionJournal({
        agentId: "retired",
        operationId: "delete-retired",
        agentDir: path.dirname(retainedPath),
        workspaceDir: state.statePath("workspace-retired"),
        sessionsDir: state.statePath("agents", "retired", "sessions"),
        deleteFiles: false,
      });
      runOpenClawStateWriteTransaction((database) => {
        completeAgentDeletionJournalInDatabase(database, "retired", "delete-retired");
      });
      if (malformed === "unrelated") {
        beginAgentDeletionJournal({
          agentId: "unrelated",
          operationId: "delete-unrelated",
          agentDir: state.statePath("agents", "unrelated", "agent"),
          workspaceDir: state.statePath("workspace-unrelated"),
          sessionsDir: state.statePath("agents", "unrelated", "sessions"),
          deleteFiles: false,
        });
        runOpenClawStateWriteTransaction((database) => {
          completeAgentDeletionJournalInDatabase(database, "unrelated", "delete-unrelated");
        });
      }
      if (malformed !== "valid") {
        runOpenClawStateWriteTransaction((database) => {
          database.db
            .prepare(
              "UPDATE agent_deletion_journal SET database_paths_json = '[1]' WHERE agent_id = ?",
            )
            .run(malformed);
        });
      }
      const bytes = fs.readFileSync(retainedPath);
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      try {
        await projection.ensureMaterialized();
        const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
        const exec = vi.spyOn(DatabaseSync.prototype, "exec");
        try {
          expect(projection.selectEntries().map((row) => row.key)).toEqual([activeKey]);
          expect(projection.describe({ agentId: "main", key: activeKey })).toBeDefined();
          expect(reads).not.toHaveBeenCalled();
          expect(exec).not.toHaveBeenCalled();
        } finally {
          reads.mockRestore();
          exec.mockRestore();
        }
        expect(fs.readFileSync(retainedPath).equals(bytes)).toBe(true);
      } finally {
        projection.dispose();
      }
    });
  },
);
