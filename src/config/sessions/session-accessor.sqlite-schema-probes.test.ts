import { constants } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import { openSqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  measureSessionSchemaProbes,
  type SessionProbeOperations,
} from "./session-accessor.sqlite-schema-probes.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("bounds schema and freshness probes across admitted session reader entry points", async () => {
  const options = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("session-schema-probes-") },
  };
  const writer = openOpenClawAgentDatabase(options);
  writeSessionEntry(writer, "agent:main:probe", { sessionId: "probe", updatedAt: 1 });
  const reader = openOpenClawAgentDatabaseReadOnly(options);
  if (!reader.found) {
    throw new Error("Session probe reader is missing");
  }
  const worker = await openSqliteWorkerStore<SessionProbeOperations>({
    moduleUrl: new URL("./session-accessor.sqlite-schema-probes.test-support.ts", import.meta.url),
    databasePath: writer.path,
    input: undefined,
  });
  try {
    const borrowed = withOpenClawAgentDatabaseReadOnly(measureSessionSchemaProbes, options);
    if (!borrowed.found) {
      throw new Error("Session probe borrowed reader is missing");
    }
    const results = {
      writer: measureSessionSchemaProbes(writer),
      readOnly: measureSessionSchemaProbes(reader.database),
      snapshot: runSqlitePinnedReadSnapshotSync(reader.database.db, () =>
        measureSessionSchemaProbes(reader.database),
      ),
      borrowed: borrowed.value,
      worker: await worker.execute({ type: "read", input: undefined }),
    };
    console.log(JSON.stringify(results));
    for (const result of Object.values(results)) {
      expect(result.admitted).toBe(true);
      expect(result.schemaVersion).toBe(0);
      expect(result.userVersion).toBe(0);
      // Freshness probes run on every use so foreign commits are visible on the next
      // read; today one session read passes through 9-11 layered uses depending on the
      // entry point. The bound holds that ceiling until the layers share one probe per
      // operation.
      expect(result.dataVersion).toBeLessThanOrEqual(12 * 100);
    }
    if (typeof writer.db.setAuthorizer === "function") {
      let allowed = true;
      writer.db.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
      const read = () =>
        readSessionEntryCache(writer, { cache: true }).entries.get("agent:main:probe");
      try {
        expect(read()?.sessionId).toBe("probe");
        writeSessionEntry(writer, "agent:main:probe", {
          sessionId: "probe",
          updatedAt: 1,
          label: "current",
        });
        expect(read()?.label).toBe("current");
        allowed = false;
        expect(read).toThrow(/not authorized/i);
      } finally {
        writer.db.setAuthorizer(null);
      }
      expect(read()?.label).toBe("current");
    }
  } finally {
    await worker.close();
    reader.database.close();
  }
});
