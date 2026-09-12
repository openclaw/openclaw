import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveInternalSessionEffectsIdentity } from "./internal-session-key.js";
import { listSessionEntriesReadOnly } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const stateDir = tempDirs.make("selected-session-list-");
  const options = {
    agentId: "main",
    path: path.join(stateDir, "sessions.sqlite"),
    env: { OPENCLAW_STATE_DIR: stateDir },
  };
  const database = openOpenClawAgentDatabase(options);
  const hidden = resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden" });
  runOpenClawAgentWriteTransaction((db) => {
    for (const name of ["c", "a", "b"]) {
      writeSessionEntry(db, `agent:main:${name}`, {
        sessionId: `session-${name}`,
        updatedAt: 1,
        skillsSnapshot: { prompt: "saved prompt", skills: [] },
      });
    }
    writeSessionEntry(db, hidden.sessionKey, { sessionId: hidden.sessionId, updatedAt: 1 });
  }, options);
  const read = (sessionKeys?: readonly string[]) =>
    listSessionEntriesReadOnly({
      agentId: options.agentId,
      env: options.env,
      storePath: options.path,
      projection: "list",
      sessionKeys,
    });
  return { database, hidden, read };
}

it.each([
  { selection: undefined, expected: ["a", "b", "c"] },
  { selection: ["c", "missing", "a", "c", "hidden"], expected: ["a", "c"] },
  { selection: [], expected: [] },
])("returns the ordered selected metadata for $selection", ({ selection, expected }) => {
  const { hidden, read } = fixture();
  const rows = read(
    selection?.map((name) => (name === "hidden" ? hidden.sessionKey : `agent:main:${name}`)),
  );
  expect(rows.map(({ sessionKey }) => sessionKey)).toEqual(
    expected.map((name) => `agent:main:${name}`),
  );
  expect(rows.every(({ entry }) => entry.skillsSnapshot === undefined)).toBe(true);
});

it.each([{ selection: [] }, { selection: ["agent:main:a"] }])(
  "retains unrelated canonical-key errors when selecting $selection",
  ({ selection }) => {
    const { database, read } = fixture();
    read();
    // Raw DML after validation must not disappear behind an unrelated selection.
    database.db
      .prepare(
        "INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at) VALUES(?, ?, ?, ?)",
      )
      .run(
        "AGENT:MAIN:UNRELATED",
        "unrelated",
        JSON.stringify({ sessionId: "unrelated", updatedAt: 1 }),
        1,
      );
    expect(() => read(selection)).toThrow("non-canonical persisted row");
  },
);
