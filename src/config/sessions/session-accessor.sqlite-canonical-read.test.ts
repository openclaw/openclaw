import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  assignSessionOwner,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("canonical SQLite metadata reads", () => {
  it.each(["agent:main:plain", "agent:main:matrix:channel:!Mixed:example.org"])(
    "omits saved prompts from metadata reads and transcript batches for %s",
    async (sessionKey) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-") };
      const scope = { agentId: "main", env, sessionKey };
      const savedPrompt = "saved prompt ".repeat(40_000);
      const keys = [...new Set([sessionKey, sessionKey.toLowerCase()])];
      for (const key of keys) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: key },
          {
            sessionId: key,
            updatedAt: 1,
            lifecycleRevision: "original",
            skillsSnapshot: { prompt: savedPrompt, skills: [] },
            systemPromptReport: {
              source: "run",
              generatedAt: 1,
              systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
              injectedWorkspaceFiles: [],
              skills: { promptChars: 1, entries: [] },
              tools: { listChars: 0, schemaChars: 0, entries: [] },
            },
          },
        );
      }
      assignSessionOwner(scope, {
        owner: { type: "agent", id: "owner" },
        assignedBy: { type: "human", id: "assigner" },
        assignedAt: 10,
      });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: "person" },
        promptedAt: 10,
      });
      const expected = { ...loadSessionEntryReadOnly(scope)! };
      delete expected.skillsSnapshot;
      delete expected.systemPromptReport;
      const database = openOpenClawAgentDatabase(scope);
      const queries = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
        /from\s+"session_nodes"/i.test(sql) ? "entries" : null,
      );
      try {
        expect(loadSessionEntryReadOnly({ ...scope, projection: "list" })).toEqual(expected);
        expect(queries.textBytes.entries).toBeLessThan(2048);
        queries.textBytes.entries = 0;
        runOpenClawAgentWriteTransaction((writer) => {
          expect(
            appendTranscriptEventsInTransaction(
              writer,
              resolveSqliteTranscriptScope({ ...scope, sessionId: sessionKey }),
              [
                { type: "custom", id: "first", parentId: null, data: "synthetic" },
                { type: "custom", id: "second", parentId: "first", data: "synthetic" },
              ],
            ),
          ).toBe(2);
        }, scope);
        expect(queries.textBytes.entries).toBeLessThan(4096);
      } finally {
        queries.restore();
      }
      // Ordinary reads and subsequent writes must still own the complete prompt payload.
      expect(loadSessionEntryReadOnly(scope)?.skillsSnapshot?.prompt).toBe(savedPrompt);
      expect(
        loadSessionEntryReadOnly({ ...scope, sessionKey: sessionKey.replace("agent:", "AGENT:") }),
      ).toEqual(loadSessionEntryReadOnly(scope));
      await patchSessionEntryCore(scope, (entry) => {
        expect(entry.skillsSnapshot?.prompt).toBe(savedPrompt);
        return { label: "renamed" };
      });
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        label: "renamed",
        skillsSnapshot: { prompt: savedPrompt },
      });
    },
  );

  it("validates a folded sibling before selecting or preparing the exact opaque target", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-sibling-") };
    const sessionKey = "agent:main:matrix:channel:!Mixed:example.org";
    const scope = { agentId: "main", env, sessionKey };
    const sibling = sessionKey.toLowerCase();
    for (const key of [sessionKey, sibling]) {
      replaceSessionEntrySync({ ...scope, sessionKey: key }, { sessionId: key, updatedAt: 1 });
    }
    loadSessionEntryReadOnly(scope);
    const database = openOpenClawAgentDatabase(scope);
    database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        sessionId: sibling,
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!Mixed:example.org" },
        }),
      }),
      sibling,
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sibling);
    for (const projection of ["full", "list"] as const) {
      expect(() => loadSessionEntryReadOnly({ ...scope, projection })).toThrow(
        "non-canonical persisted row",
      );
    }
    const shouldAppend = vi.fn(() => true);
    await expect(
      persistSessionTranscriptTurn(
        { ...scope, sessionId: sessionKey },
        {
          expectedSessionId: sessionKey,
          messages: [{ message: { role: "user", content: "must not prepare" }, shouldAppend }],
          updateMode: "none",
        },
      ),
    ).rejects.toThrow("non-canonical persisted row");
    expect(shouldAppend).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "{"],
    ["identity mismatch", '{"sessionId":"other","updatedAt":1}'],
    ["timestamp mismatch", '{"sessionId":"target","updatedAt":2}'],
    ["prompt-only", '{"skillsSnapshot":{"prompt":"saved"}}'],
    ["literal NUL", '{"sessionId":"target","updatedAt":1}\u0000trailing'],
  ])("preserves canonical failures for %s rows", (_name, json) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-invalid-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1 });
    loadSessionEntryReadOnly(scope);
    const database = openOpenClawAgentDatabase(scope);
    database.db.prepare("UPDATE session_nodes SET entry_json = ?").run(json);
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
    for (const projection of ["full", "list"] as const) {
      expect(() => loadSessionEntryReadOnly({ ...scope, projection })).toThrow(
        "invalid persisted session row",
      );
    }
  });

  it("keeps overdepth metadata readable and retained windows absent", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-depth-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    replaceSessionEntrySync(scope, { sessionId: "target", updatedAt: 1 });
    loadSessionEntryReadOnly(scope);
    const database = openOpenClawAgentDatabase(scope);
    const update = database.db.prepare("UPDATE session_nodes SET entry_json = ?");
    update.run(
      `{"sessionId":"target","updatedAt":1,"skillsSnapshot":{"prompt":"saved","skills":[],"deep":${"[".repeat(1001)}0${"]".repeat(1001)}}}`,
    );
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
    expect(loadSessionEntryReadOnly(scope)?.skillsSnapshot?.prompt).toBe("saved");
    expect(loadSessionEntryReadOnly({ ...scope, projection: "list" })).toEqual({
      sessionId: "target",
      updatedAt: 1,
    });
    update.run("{}");
    database.db.prepare("UPDATE session_nodes SET entry_valid = -1").run();
    for (const projection of ["full", "list"] as const) {
      expect(loadSessionEntryReadOnly({ ...scope, projection })).toBeUndefined();
    }
  });

  it("does not create a missing database for a metadata read", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-missing-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:missing" };
    expect(loadSessionEntryReadOnly({ ...scope, projection: "list" })).toBeUndefined();
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
  });
});
