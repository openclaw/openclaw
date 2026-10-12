import { expect, test, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import type { AcpSessionReadInput } from "../acp/runtime/session-meta-read.types.js";
import * as acpSessionMeta from "../acp/runtime/session-meta-readonly.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeRetainedOpenClawStateReadConnections } from "../state/openclaw-state-db-read-connection.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "../state/openclaw-state-read.types.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import * as rowProjection from "./session-utils-row.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";

const stateWorker = vi.hoisted(() => ({
  read: vi.fn<(input: OpenClawStateReadRequest) => Promise<OpenClawStateReadReply>>(),
}));
vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks(
    handler: (input: OpenClawStateReadRequest) => Promise<OpenClawStateReadReply>,
  ) {
    stateWorker.read.mockImplementation(handler);
  },
}));
import "../state/openclaw-state-read.worker.js";

test("retains ACP batch bounds while clean lists and canonical metadata updates reuse resident facts", async () => {
  await withStateDirEnv("openclaw-perf-acp-", async ({ stateDir }) => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5" },
          models: { "openai/gpt-5": { agentRuntime: { id: "openclaw" } } },
          thinkingDefault: "off",
        },
      },
    } as OpenClawConfig;
    resetConfigRuntimeState();
    setRuntimeConfigSnapshot(cfg);

    const stateKey = "agent:default:webchat:dm:state";
    const missingKey = "agent:default:webchat:dm:missing";
    const markerKey = "agent:default:webchat:dm:marker";
    const stateEntry: SessionEntry = {
      sessionId: "state-session",
      updatedAt: 3,
      modelProvider: "openai",
      model: "gpt-5",
    };
    const missingEntry: SessionEntry = {
      sessionId: "missing-session",
      updatedAt: 2,
      modelProvider: "openai",
      model: "gpt-5",
    };
    const staleAliasEntry: SessionEntry = {
      sessionId: "stale-alias-session",
      updatedAt: 1,
      modelProvider: "openai",
      model: "gpt-5",
    };
    const markerMeta = {
      backend: "marker",
      agent: "marker-agent",
      runtimeSessionName: markerKey,
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 1,
    };
    const markerEntry: SessionEntry = {
      sessionId: "marker-session",
      updatedAt: 1,
      modelProvider: "openai",
      model: "gpt-5",
    };
    const stateMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: stateKey,
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 2,
    };
    seedCanonicalAcpSessionMeta({
      sessionKey: stateKey,
      sessionId: stateEntry.sessionId,
      meta: stateMeta,
      now: () => 100,
    });

    seedCanonicalAcpSessionMeta({
      sessionKey: markerKey,
      sessionId: markerEntry.sessionId,
      meta: markerMeta,
    });

    const database = openOpenClawStateDatabase();
    let projection: SessionRowProjection | undefined;
    const acpSelects = trackSqliteStatementExecutions(database.db, ["metadata"], (sql) =>
      /^select\b.*\bacp_sessions\b/is.test(sql) ? "metadata" : null,
    );
    try {
      const unboundKey = "agent:default:webchat:dm:unbound";
      seedCanonicalAcpSessionMeta({
        sessionKey: unboundKey,
        meta: { ...markerMeta, runtimeSessionName: unboundKey },
      });
      const key = (sessionKey: string, agentId = "default") =>
        buildAcpDatabaseSessionKey(sessionKey, agentId);
      const cohort: AcpSessionReadInput[] = [
        { keys: [key(stateKey)], entry: stateEntry },
        { keys: [key(stateKey)], entry: staleAliasEntry },
        { keys: [key(missingKey), key(stateKey)], entry: stateEntry },
        { keys: [key(stateKey), key(markerKey)], entry: markerEntry },
        { keys: [key(markerKey), key(stateKey)] },
        { keys: [key(stateKey), key(unboundKey)] },
        { keys: [key(unboundKey)], entry: staleAliasEntry },
        { keys: [key(stateKey)], entry: { sessionId: "state-session", sessionStartedAt: 101 } },
        { keys: [key(stateKey)], entry: { sessionId: "state-session", sessionStartedAt: 100 } },
        {
          keys: [key(stateKey)],
          entry: { lifecycleRevision: "state-session", sessionId: "other", sessionStartedAt: 101 },
        },
        { keys: [key(stateKey, "other")], entry: stateEntry },
        { keys: [key(stateKey), key(stateKey)], entry: stateEntry },
        ...Array.from({ length: 52 }, (_, index) => ({
          keys: [key(`agent:default:webchat:dm:cohort-missing-${index}`)],
          entry: missingEntry,
        })),
      ];
      const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const reply = await stateWorker.read({
          context: { environment: { OPENCLAW_STATE_DIR: stateDir } },
          databasePath: database.path,
          location: database.path,
          checkFreshAdmission: false,
          command: { type: "acpSessions.metadata", entries: cohort },
        });
        if (!reply.ok || reply.type !== "acpSessions.metadata") {
          throw new Error("ACP worker metadata read failed");
        }
        expect(reply.rows.map((row) => row?.runtime_session_name ?? null)).toEqual([
          stateKey,
          null,
          stateKey,
          markerKey,
          markerKey,
          stateKey,
          unboundKey,
          null,
          stateKey,
          stateKey,
          null,
          stateKey,
          ...Array.from({ length: 52 }, () => null),
        ]);
        expect(
          sql.queries.filter((query) => /^select\b.*\bacp_sessions\b/is.test(query)),
        ).toHaveLength(1);
      } finally {
        sql.restore();
        closeRetainedOpenClawStateReadConnections();
      }
      acpSelects.counts.metadata = 0;
      // Canonical identities share the production 500-key chunks.
      // Cross a boundary without materializing tens of thousands of rows.
      const aboveBatchChunkSize = Array.from({ length: 501 }, (_, index) => ({
        sessionKey: `agent:default:webchat:dm:missing-${index}`,
        entry: {
          sessionId: `missing-session-${index}`,
          updatedAt: index,
        } satisfies SessionEntry,
      }));
      const chunkSql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const chunkedBatch = await stateWorker.read({
          context: { environment: { OPENCLAW_STATE_DIR: stateDir } },
          databasePath: database.path,
          location: database.path,
          checkFreshAdmission: false,
          command: {
            type: "acpSessions.metadata",
            entries: aboveBatchChunkSize.map(({ sessionKey, entry }) => ({
              keys: [key(sessionKey)],
              entry,
            })),
          },
        });
        if (!chunkedBatch.ok || chunkedBatch.type !== "acpSessions.metadata") {
          throw new Error("ACP worker chunked metadata read failed");
        }
        expect(chunkedBatch.rows).toHaveLength(aboveBatchChunkSize.length);
        expect(chunkedBatch.rows.every((row) => row === null)).toBe(true);
        expect(
          chunkSql.queries.filter((query) => /^select\b.*\bacp_sessions\b/is.test(query)),
        ).toHaveLength(2);
      } finally {
        chunkSql.restore();
        closeRetainedOpenClawStateReadConnections();
      }

      const runtimeEntries = Object.fromEntries(
        aboveBatchChunkSize
          .slice(0, 55)
          .map(({ sessionKey, entry }) => [
            sessionKey.replace("agent:default:", "agent:runtime:"),
            entry,
          ]),
      );
      writeResidentEntries({
        [stateKey]: stateEntry,
        [missingKey]: missingEntry,
        [markerKey]: markerEntry,
        ...runtimeEntries,
      });
      projection = await createSessionRowProjection({ cfg });
      await projection.ensureMaterialized();
      acpSelects.counts.metadata = 0;
      const rows = vi.spyOn(rowProjection, "readSessionRowInputs");
      const metadataReads = vi.spyOn(acpSessionMeta, "readAcpSessionMetaForEntry");
      try {
        const result = await listProjectedSessions({
          projection,
          opts: { agentId: "default", limit: 3 },
        });
        expect(result.sessions).toHaveLength(3);
        expect(acpSelects.counts.metadata).toBe(0);
        for (const search of ["openclaw", "unmatched-runtime"]) {
          const searched = await listProjectedSessions({
            projection,
            opts: { agentId: "runtime", search, limit: 1 },
          });
          expect(searched.totalCount).toBe(search === "openclaw" ? 55 : 0);
          expect(rows).not.toHaveBeenCalled();
          expect(acpSelects.counts.metadata).toBe(0);
        }
        expect(
          projection.snapshot({ agentId: "default", key: missingKey }).row?.runtimeSelectionLocked,
        ).toBe(false);
        seedCanonicalAcpSessionMeta({
          sessionKey: missingKey,
          sessionId: missingEntry.sessionId,
          meta: { ...markerMeta, runtimeSessionName: missingKey },
        });
        writeResidentEntries(
          {
            [missingKey]: missingEntry,
          },
          1,
        );
        acpSelects.counts.metadata = 0;
        await projection.ensureMaterialized();
        expect(rows).toHaveBeenCalledOnce();
        expect(rows.mock.calls[0]?.[0].key).toBe(missingKey);
        expect(metadataReads).not.toHaveBeenCalled();
        expect(acpSelects.counts.metadata).toBe(0);
        expect(
          projection.snapshot({ agentId: "default", key: missingKey }).row?.runtimeSelectionLocked,
        ).toBe(true);
      } finally {
        metadataReads.mockRestore();
        rows.mockRestore();
      }
    } finally {
      projection?.dispose();
      acpSelects.restore();
    }
  });
});
