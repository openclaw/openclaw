import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  readReferencedSessionIds,
  withBatchedSessionReferenceAnalysis,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { trackMaterializedKeys } from "./session-accessor.sqlite-read-tracking.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function makeStore() {
  const stateDir = tempDirs.make("openclaw-reference-batch-");
  const pathname = path.join(stateDir, "agent.sqlite");
  const options = {
    agentId: "main",
    path: pathname,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  return { options, pathname };
}

function insertEntry(
  database: Pick<OpenClawAgentDatabase, "db">,
  key: string,
  id: string,
  json?: string,
) {
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, CAST(? AS TEXT), ?)",
    )
    .run(key, id, json ?? JSON.stringify({ sessionId: id, updatedAt: 1 }), 1);
}

/**
 * Commits a reference from a connection this process is not holding open, which
 * is the only writer shape `PRAGMA data_version` exists to report.
 */
function commitExternalReference(pathname: string, ownerKey: string, referencedSessionId: string) {
  const writer = new DatabaseSync(pathname);
  try {
    insertEntry(
      { db: writer },
      ownerKey,
      `${ownerKey}-current`,
      JSON.stringify({
        sessionId: `${ownerKey}-current`,
        updatedAt: 1,
        previousSessionId: referencedSessionId,
      }),
    );
  } finally {
    writer.close();
  }
}

describe("SQLite reference batches across a replaced connection", () => {
  it("reports a reference committed while the batch's handle was closed", async () => {
    const { options, pathname } = makeStore();
    const primed = openOpenClawAgentDatabase(options);
    insertEntry(primed, "unrelated", "unrelated-current");

    const primedHandle = primed.db;
    await withBatchedSessionReferenceAnalysis(primed, ["victim"], async () => {
      // The priming scan found no holder, so the memo answers "free".
      expect(readReferencedSessionIds(primed, undefined, ["victim"])).toEqual(new Set());

      // Archive materialization releases the writer, and an unborrowed handle
      // can be evicted while the sweep is still working through this batch.
      closeOpenClawAgentDatabaseByPath(pathname);
      commitExternalReference(pathname, "live-owner", "victim");
      const reopened = openOpenClawAgentDatabase(options);
      expect(reopened.db === primedHandle).toBe(false);
      expect(primedHandle.isOpen).toBe(false);

      // Both halves of the validity token are connection-local: `data_version`
      // restarts on a new handle and the TEMP generation counter starts at zero,
      // so they match the primed token by coincidence rather than by proving the
      // store is unchanged. The live reference must still be reported.
      expect(readReferencedSessionIds(reopened, undefined, ["victim"])).toEqual(
        new Set(["victim"]),
      );
    });
  });

  it("still answers from the memo while the priming handle is current", async () => {
    const { options } = makeStore();
    const primed = openOpenClawAgentDatabase(options);
    insertEntry(
      primed,
      "holder",
      "holder-current",
      JSON.stringify({ sessionId: "holder-current", updatedAt: 1, previousSessionId: "held" }),
    );

    await withBatchedSessionReferenceAnalysis(primed, ["held"], async () => {
      const materializedKeys = trackMaterializedKeys(primed);
      expect(readReferencedSessionIds(primed, undefined, ["held"])).toEqual(new Set(["held"]));
      // A fallback read would have listed "holder" here.
      expect(materializedKeys).toEqual([]);
    });
  });

  it("keeps batching the rest of the candidates after the handle is replaced", async () => {
    const { options, pathname } = makeStore();
    const primed = openOpenClawAgentDatabase(options);
    insertEntry(
      primed,
      "holder",
      "holder-current",
      JSON.stringify({ sessionId: "holder-current", updatedAt: 1, previousSessionId: "second" }),
    );

    await withBatchedSessionReferenceAnalysis(primed, ["first", "second"], async () => {
      closeOpenClawAgentDatabaseByPath(pathname);
      const reopened = openOpenClawAgentDatabase(options);
      // The first question on the replaced handle rebuilds the batch.
      expect(readReferencedSessionIds(reopened, undefined, ["first"])).toEqual(new Set());

      // The rebuilt batch must serve the remaining candidates from that one pass
      // rather than degrading to a full re-scan per candidate.
      const materializedKeys = trackMaterializedKeys(reopened);
      expect(readReferencedSessionIds(reopened, undefined, ["second"])).toEqual(
        new Set(["second"]),
      );
      expect(materializedKeys).toEqual([]);
    });
  });

  it("detects an external write that lands after the handle is replaced", async () => {
    const { options, pathname } = makeStore();
    const primed = openOpenClawAgentDatabase(options);
    insertEntry(primed, "unrelated", "unrelated-current");

    await withBatchedSessionReferenceAnalysis(primed, ["late"], async () => {
      closeOpenClawAgentDatabaseByPath(pathname);
      const reopened = openOpenClawAgentDatabase(options);
      expect(readReferencedSessionIds(reopened, undefined, ["late"])).toEqual(new Set());

      // The rebuilt token belongs to the live handle, so an ordinary external
      // commit invalidates it the way the design intends.
      commitExternalReference(pathname, "late-owner", "late");
      expect(readReferencedSessionIds(reopened, undefined, ["late"])).toEqual(new Set(["late"]));
    });
  });
});
