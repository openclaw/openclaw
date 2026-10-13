import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as sqlite from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";

it("preserves programming failures when required tables remain available", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    openOpenClawAgentDatabase(options);
    const failure = new TypeError("invalid reader operation");
    expect(() =>
      withOpenClawAgentDatabaseReadOnly(() => {
        throw failure;
      }, options),
    ).toThrow(failure);
    expect(() =>
      withOpenClawAgentDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT * FROM missing_readonly_table").all(),
        options,
      ),
    ).toThrow(/no such table: missing_readonly_table/);
  });
});

it.each([false, true])("records absent admission tables (fresh-only: %s)", async (freshOnly) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const owner = openOpenClawAgentDatabase(options);
    owner.db.exec("DROP TABLE session_canonical_validation_pending;");
    let readDb: DatabaseSync = owner.db;
    const nativeOpen = sqlite.openNodeSqliteDatabase;
    const open = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const database = nativeOpen(...args);
      if (args[0] === owner.path) {
        readDb = database;
      }
      return database;
    });
    const readOnly = freshOnly
      ? withFreshOpenClawAgentDatabaseReadOnly
      : withOpenClawAgentDatabaseReadOnly;
    const operation = vi.fn(({ db }: { db: DatabaseSync }) =>
      db.prepare("SELECT * FROM session_nodes").all(),
    );
    const read = () => readOnly(operation, options);
    const unavailable = expect.objectContaining({
      name: "SessionMetadataUnavailableError",
      reason: "table-missing",
      missingTables: ["session_canonical_validation_pending"],
      cause: expect.objectContaining({
        message: expect.stringMatching(
          /canonical validation schema is missing or drifted.*openclaw doctor --fix/u,
        ),
      }),
    });

    try {
      expect(read).toThrow(unavailable);
      expect(operation).not.toHaveBeenCalled();
      expect(readDb === owner.db).toBe(!freshOnly);
      expect(readDb.isOpen).toBe(!freshOnly);
      expect(owner.db.isOpen).toBe(true);
      expect(closeOpenClawAgentDatabaseByPath(owner.path)).toBe(true);
      expect(read).toThrow(unavailable);
      expect(operation).not.toHaveBeenCalled();
      expect(readDb.isOpen).toBe(false);
    } finally {
      open.mockRestore();
    }
  });
});
