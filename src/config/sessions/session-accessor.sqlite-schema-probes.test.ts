import { constants } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import { openSqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import * as entryCache from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as identityPublication from "./session-accessor.sqlite-identity.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import {
  measureSessionSchemaProbes,
  type SessionProbeOperations,
} from "./session-accessor.sqlite-schema-probes.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([false, true])(
  "publishes native writes without new generation probes (warm=%s)",
  (warm) => {
    const options = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("session-publication-probes-") },
    };
    const writer = openOpenClawAgentDatabase(options);
    if (warm) {
      entryCache.readSessionEntryCache(writer, { cache: true });
    }
    const sql = observeHostDataSql(options.env);
    const publicationQueries: string[] = [];
    const observePublication = <T>(publish: () => T): T => {
      const start = sql.queries.length;
      try {
        return publish();
      } finally {
        publicationQueries.push(
          ...sql.queries
            .slice(start)
            .filter((query) => query.includes("openclaw_session_nodes_cache_generation")),
        );
      }
    };
    const publishEntry = entryCache.publishSessionEntryCacheInvalidation;
    const cachePublication = vi
      .spyOn(entryCache, "publishSessionEntryCacheInvalidation")
      .mockImplementation((...args) => observePublication(() => publishEntry(...args)));
    const publishIdentity = identityPublication.prepareSessionIdentityPublication;
    const lifecyclePublication = vi
      .spyOn(identityPublication, "prepareSessionIdentityPublication")
      .mockImplementation((...args) => observePublication(() => publishIdentity(...args)));
    const replacementKey = "agent:main:publication-replacement";
    const initialKey = "agent:main:publication-initial";
    try {
      replaceSessionEntrySync(
        { ...options, storePath: writer.path, sessionKey: replacementKey },
        { sessionId: "publication-replacement", updatedAt: 1, label: "replacement" },
      );
      expect(
        ensureSessionEntrySync(
          { ...options, storePath: writer.path, sessionKey: initialKey },
          { sessionId: "publication-initial", updatedAt: 1, label: "initial" },
        ),
      ).toBe(true);
      expect(cachePublication).toHaveBeenCalled();
      expect(lifecyclePublication).toHaveBeenCalled();
      expect(publicationQueries).toEqual([]);
      expect(readExactSessionEntryRow(writer, replacementKey)?.entry.label).toBe("replacement");
      expect(readExactSessionEntryRow(writer, initialKey)?.entry.label).toBe("initial");
    } finally {
      lifecyclePublication.mockRestore();
      cachePublication.mockRestore();
      sql.restore();
    }
  },
);

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
    for (const result of Object.values(results).flatMap(Object.values)) {
      expect(result.admitted).toBe(true);
      expect(result.schemaVersion).toBe(0);
      expect(result.userVersion).toBe(0);
      expect(result.dataVersion).toBeLessThanOrEqual(100);
    }
    if (typeof writer.db.setAuthorizer === "function") {
      let allowed = true;
      writer.db.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
      const read = () =>
        entryCache.readSessionEntryCache(writer, { cache: true }).entries.get("agent:main:probe");
      const publications: Array<{
        prepared: ReturnType<typeof readPreparedSessionEntryChange>;
        sharing: ReturnType<typeof readPreparedSessionSharingChange>;
      }> = [];
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === "agent:main:probe") {
          publications.push({
            prepared: readPreparedSessionEntryChange(change, change.sessionKey),
            sharing: readPreparedSessionSharingChange(change),
          });
        }
      });
      try {
        expect(read()?.sessionId).toBe("probe");
        writeSessionEntry(writer, "agent:main:probe", {
          sessionId: "probe",
          updatedAt: 1,
          label: "current",
        });
        expect(publications).toEqual([{ prepared: undefined, sharing: "unchanged" }]);
        expect(read()?.label).toBe("current");
        allowed = false;
        expect(read).toThrow(/not authorized/i);
      } finally {
        stop();
        writer.db.setAuthorizer(null);
      }
      expect(read()?.label).toBe("current");
    }
  } finally {
    await worker.close();
    reader.database.close();
  }
});
