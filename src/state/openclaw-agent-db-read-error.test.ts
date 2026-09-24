import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
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

it.each([false, true])("records missing required tables (fresh-only: %s)", async (freshOnly) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const owner = openOpenClawAgentDatabase(options);
    owner.db.exec("DROP TABLE session_nodes;");
    let readDb: DatabaseSync | undefined;
    const readOnly = freshOnly
      ? withFreshOpenClawAgentDatabaseReadOnly
      : withOpenClawAgentDatabaseReadOnly;
    const read = () =>
      readOnly(({ db }) => {
        readDb = db;
        return db.prepare("SELECT * FROM session_nodes").all();
      }, options);
    const unavailable = expect.objectContaining({
      name: "SessionMetadataUnavailableError",
      reason: "table-missing",
      missingTables: ["session_nodes"],
      cause: expect.objectContaining({ code: "ERR_SQLITE_ERROR" }),
    });

    expect(read).toThrow(unavailable);
    expect(readDb === owner.db).toBe(!freshOnly);
    expect(readDb?.isOpen).toBe(!freshOnly);
    expect(owner.db.isOpen).toBe(true);
    expect(closeOpenClawAgentDatabaseByPath(owner.path)).toBe(true);
    expect(read).toThrow(unavailable);
    expect(readDb?.isOpen).toBe(false);
  });
});
