import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import * as readOnlyScope from "../../state/openclaw-agent-db-readonly-scope.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionHistoryReadOperation } from "./session-history-read-operation.worker.js";
import type { SessionTranscriptPageReadWorkerInput } from "./session-transcript-worker-read.types.js";
import { createSessionHistoryWorkerReaders } from "./session-transcript-worker-readers.js";

async function withFixture(run: (input: SessionTranscriptPageReadWorkerInput) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:identity",
      sessionId: "identity",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await replaceTranscriptEvents({ ...scope, storePath: scope.path }, [
      { type: "session", id: scope.sessionId, version: 3 },
    ]);
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
    await run({
      kind: "transcript-page-read",
      database: { agentId: scope.agentId, path: scope.path },
      request: {
        scope,
        expectedLifecycleRevision: "original",
        limits: { limit: 2, maxScannedEntries: 1000, maxMaterializedBytes: 16 * 1024 * 1024 },
      },
      expectedIdentity: readDatabasePathIdentitySync(scope.path),
    });
  });
}

it("accepts a matching file identity without an optional birthtime", async () => {
  await withFixture(async (input) => {
    const execute = await prepareSessionHistoryReadOperation({
      ...input,
      expectedIdentity: { key: input.expectedIdentity.key },
    });
    expect(execute()).toMatchObject({ kind: "transcript-page-read", result: { ok: true } });
  });
});

function replaceOrRemove(pathname: string, mode: "replacement" | "deletion") {
  // Keep the original inode allocated so replacement cannot reuse it.
  fs.renameSync(pathname, pathname + ".original");
  if (mode === "replacement") {
    fs.writeFileSync(pathname, "synthetic replacement; must never be read");
  }
}

it.each([
  ["preparation", "replacement", "stale_session"],
  ["receipt", "replacement", "stale_session"],
  ["preparation", "deletion", "missing"],
  ["receipt", "deletion", "missing"],
] as const)("rejects %s %s at the host reader with %s", async (phase, mode, error) => {
  await withFixture(async (input) => {
    const receiptBudget = {
      scannedEntries: 3,
      materializedBytes: 91,
      exhausted: false,
      final: true,
    };
    const readers = createSessionHistoryWorkerReaders(async (prepare, _bytes, receive) => {
      if (phase === "preparation") {
        replaceOrRemove(input.database.path, mode);
      }
      prepare();
      if (phase === "receipt") {
        replaceOrRemove(input.database.path, mode);
      }
      return receive({
        kind: "transcript-page-read",
        result: { ok: true, value: { generation: "original", records: [] }, budget: receiptBudget },
      });
    });
    await expect(readers.readTranscriptPage(input)).resolves.toEqual({
      ok: false,
      error,
      budget:
        phase === "receipt"
          ? receiptBudget
          : // Rejection before native preparation proves that no source rows
            // were fetched; the empty accounting receipt is complete.
            { scannedEntries: 0, materializedBytes: 0, exhausted: false, final: true },
    });
  });
});

it("never issues page-read SQL through a host-held writable database handle", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:writable-hold",
      sessionId: "writable-hold",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await replaceTranscriptEvents({ ...scope, storePath: scope.path }, [
      { type: "session", id: scope.sessionId, version: 3 },
    ]);
    const observed = trackSqliteStatementExecutions(writer.db, ["writer"], () => "writer");
    try {
      const execute = await prepareSessionHistoryReadOperation({
        kind: "transcript-page-read",
        database: { agentId: scope.agentId, path: scope.path },
        request: {
          scope,
          expectedLifecycleRevision: "original",
          limits: { limit: 2, maxScannedEntries: 1000, maxMaterializedBytes: 16 * 1024 * 1024 },
        },
        expectedIdentity: readDatabasePathIdentitySync(scope.path),
      });
      const { result } = execute();
      expect(result.ok).toBe(true);
    } finally {
      observed.restore();
    }
    expect(observed.counts.writer).toBe(0);
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
  });
});

it.each([
  ["before read", "replacement", "stale_session"],
  ["after read", "replacement", "stale_session"],
  ["before read", "deletion", "missing"],
  ["after read", "deletion", "missing"],
] as const)("rejects %s %s at the worker dispatcher with %s", async (phase, mode, error) => {
  await withFixture(async (input) => {
    const original = readOnlyScope.withScopedOpenClawAgentDatabaseReadOnly;
    const spy = vi
      .spyOn(readOnlyScope, "withScopedOpenClawAgentDatabaseReadOnly")
      .mockImplementation(
        new Proxy(original, {
          apply(target, receiver, args) {
            const result = Reflect.apply(target, receiver, args);
            replaceOrRemove(input.database.path, mode);
            return result;
          },
        }),
      );
    try {
      const execute = await prepareSessionHistoryReadOperation(input);
      if (phase === "before read") {
        replaceOrRemove(input.database.path, mode);
      }
      const { result } = execute();
      expect(result).toMatchObject({ ok: false, error, budget: { final: true } });
      if (phase === "after read") {
        expect(result.budget.scannedEntries).toBeGreaterThan(0);
        expect(result.budget.materializedBytes).toBeGreaterThan(0);
      } else {
        expect(result.budget.scannedEntries).toBe(0);
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      spy.mockRestore();
    }
  });
});
