import { expect, it } from "vitest";
import { readSqliteDataVersion } from "../../infra/sqlite-schema-facts.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";

it.each([
  { field: "lifecycleRevision", value: "raw-successor", code: "REVOKED" },
  { field: "permissionMode", value: "read-only", code: "UNAVAILABLE" },
  { field: "toolOverrides", value: { webSearch: false }, code: "UNAVAILABLE" },
  { field: "current_session_id", value: "raw-successor", code: "UNAVAILABLE" },
] as const)(
  "retires a prepared generation after observing a raw $field mutation on its native handle",
  async ({ field, value, code }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:raw-generation",
      };
      const original = {
        sessionId: "e1234567-1234-1234-1234-123456789abc",
        lifecycleRevision: "original-lifecycle",
        permissionMode: "full" as const,
        toolOverrides: { webSearch: true },
        updatedAt: 1,
      };
      replaceSessionEntrySync(scope, original);
      const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
      try {
        const metadata = { ...original, label: "native metadata" };
        replaceSessionEntrySync(scope, metadata);
        generation.assertCurrent();
        expect(generation.readSessionSettings()).toEqual({
          permissionMode: original.permissionMode,
          toolOverrides: original.toolOverrides,
        });

        const version = readSqliteDataVersion(database.db);
        const write = database.db.prepare(
          "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
        );
        write.run(
          field === "current_session_id" ? value : original.sessionId,
          JSON.stringify(
            field === "current_session_id" ? metadata : { ...metadata, [field]: value },
          ),
          scope.sessionKey,
        );
        expect(readSqliteDataVersion(database.db)).toBe(version);
        expect(generation.assertCurrent).toThrow(
          expect.objectContaining({ code: `SESSION_DELIVERY_GENERATION_${code}` }),
        );

        write.run(original.sessionId, JSON.stringify(metadata), scope.sessionKey);
        expect(generation.assertCurrent).toThrow(
          expect.objectContaining({ code: `SESSION_DELIVERY_GENERATION_${code}` }),
        );
      } finally {
        generation.release();
      }
    });
  },
);

it("retains unchanged generation authority inside a native transaction and after rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:transaction-generation",
    };
    const original = {
      sessionId: "e1234567-1234-1234-1234-123456789abc",
      lifecycleRevision: "original-lifecycle",
      updatedAt: 1,
    };
    replaceSessionEntrySync(scope, original);
    const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
    const rollback = new Error("Synthetic transaction rollback");
    try {
      expect(() =>
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE session_nodes SET updated_at = updated_at WHERE session_key = ?",
            ).run(scope.sessionKey);
            generation.assertCurrent();
            db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
              JSON.stringify({ ...original, lifecycleRevision: "tentative-lifecycle" }),
              scope.sessionKey,
            );
            expect(generation.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
            );
            throw rollback;
          },
          { agentId: scope.agentId, path: scope.storePath },
        ),
      ).toThrow(rollback);
      generation.assertCurrent();
    } finally {
      generation.release();
    }
  });
});

it("refuses reentrant delivery during raw execution and unfinished RETURNING cursors", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:raw-execution",
    };
    const original = {
      sessionId: "e1234567-1234-1234-1234-123456789abc",
      lifecycleRevision: "original-lifecycle",
      updatedAt: 1,
    };
    replaceSessionEntrySync(scope, original);
    const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
    let callbacks = 0;
    database.db.function("assert_delivery_fenced", () => {
      callbacks += 1;
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
      return 1;
    });
    try {
      // A SELECT can call arbitrary native callbacks without changing a mutation revision.
      database.db.exec("SELECT assert_delivery_fenced()");
      for (const method of ["run", "get", "all"] as const) {
        database.db.prepare("SELECT assert_delivery_fenced()")[method]();
      }
      const read = database.db.prepare("SELECT assert_delivery_fenced()").iterate();
      expect(read.next().done).toBe(false);
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
      read.return?.();
      expect(callbacks).toBe(5);
      generation.assertCurrent();

      const write = database.db.prepare(
        "UPDATE session_nodes SET updated_at = updated_at WHERE session_key = ? RETURNING session_key",
      );
      const rows = write.iterate(scope.sessionKey);
      expect(rows.next().value).toEqual({ session_key: scope.sessionKey });
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
      rows.return?.();
      generation.assertCurrent();
    } finally {
      generation.release();
    }
  });
});
