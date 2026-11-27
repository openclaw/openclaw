import { expect, test, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import type { AcpSessionReadInput } from "../acp/runtime/session-meta-read.types.js";
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
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
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
    const makeEntry = (sessionId: string, updatedAt: number): SessionEntry => ({
      sessionId,
      updatedAt,
      modelProvider: "openai",
      model: "gpt-5",
    });
    const stateEntry = makeEntry("state-session", 3);
    const missingEntry = makeEntry("missing-session", 2);
    const markerMeta = {
      backend: "marker",
      agent: "marker-agent",
      runtimeSessionName: markerKey,
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 1,
    };
    const markerEntry = makeEntry("marker-session", 1);
    seedCanonicalAcpSessionMeta({
      sessionKey: stateKey,
      sessionId: stateEntry.sessionId,
      meta: {
        ...markerMeta,
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: stateKey,
        lastActivityAt: 2,
      },
      now: () => 100,
    });
    seedCanonicalAcpSessionMeta({
      sessionKey: markerKey,
      sessionId: markerEntry.sessionId,
      meta: markerMeta,
    });

    const database = openOpenClawStateDatabase();
    async function readMetadata(entries: AcpSessionReadInput[], expectedQueries: number) {
      const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const reply = await stateWorker.read({
          context: { environment: { OPENCLAW_STATE_DIR: stateDir } },
          databasePath: database.path,
          location: database.path,
          checkFreshAdmission: false,
          command: { type: "acpSessions.metadata", entries },
        });
        if (!reply.ok || reply.type !== "acpSessions.metadata") {
          throw new Error("ACP worker metadata read failed");
        }
        expect(
          sql.queries.filter((query) => /^select\b.*\bacp_sessions\b/is.test(query)),
        ).toHaveLength(expectedQueries);
        return reply.rows;
      } finally {
        sql.restore();
        closeRetainedOpenClawStateReadConnections();
      }
    }
    let projection: SessionRowProjection | undefined;
    const acpSelects = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["metadata"],
      (sql) => (/^select\b.*\bacp_sessions\b/is.test(sql) ? "metadata" : null),
    );
    try {
      const key = (sessionKey: string, agentId = "default") =>
        buildAcpDatabaseSessionKey(sessionKey, agentId);
      const cohort: [
        keys: readonly string[],
        entry: AcpSessionReadInput["entry"],
        expected: string | null,
      ][] = [
        [[key(stateKey)], stateEntry, stateKey],
        [[key(missingKey), key(stateKey)], stateEntry, stateKey],
        [[key(stateKey), key(markerKey)], markerEntry, markerKey],
        [[key(markerKey), key(stateKey)], markerEntry, markerKey],
        [
          [key(stateKey)],
          { lifecycleRevision: "state-session", sessionId: "other", sessionStartedAt: 101 },
          stateKey,
        ],
        [[key(stateKey, "other")], stateEntry, null],
        [[key(stateKey), key(stateKey)], stateEntry, stateKey],
      ];
      const metadata = await readMetadata(
        cohort.map(([keys, entry]) => ({ keys, entry })),
        1,
      );
      expect(metadata.map((row) => row?.runtime_session_name ?? null)).toEqual(
        cohort.map((scenario) => scenario[2]),
      );
      acpSelects.counts.metadata = 0;
      const aboveBatchChunkSize = Array.from({ length: 501 }, (_, index) => ({
        sessionKey: `agent:default:webchat:dm:missing-${index}`,
        entry: { sessionId: `missing-session-${index}`, updatedAt: index },
      }));
      const chunkedBatch = await readMetadata(
        aboveBatchChunkSize.map(({ sessionKey, entry }) => ({
          keys: [key(sessionKey)],
          entry,
        })),
        2,
      );
      expect(chunkedBatch).toHaveLength(aboveBatchChunkSize.length);
      expect(chunkedBatch.every((row) => row === null)).toBe(true);

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
      const resident = await createSessionRowProjection({ cfg });
      projection = resident;
      const list = (agentId = "default", search?: string) =>
        listProjectedSessions({
          projection: resident,
          opts: { agentId, limit: agentId === "default" ? 3 : 1, search },
        });
      const locked = () =>
        resident.snapshot({ agentId: "default", key: missingKey }).row?.runtimeSelectionLocked;
      await projection.ensureMaterialized();
      await list();
      await list("runtime");
      acpSelects.counts.metadata = 0;
      const result = await list();
      expect(result.sessions).toHaveLength(3);
      expect(acpSelects.counts.metadata).toBe(0);
      for (const search of ["openclaw", "unmatched-runtime"]) {
        const searched = await list("runtime", search);
        expect(searched.totalCount).toBe(search === "openclaw" ? 55 : 0);
        expect(acpSelects.counts.metadata).toBe(0);
      }
      expect(locked()).toBe(false);
      seedCanonicalAcpSessionMeta({
        sessionKey: missingKey,
        sessionId: missingEntry.sessionId,
        meta: { ...markerMeta, runtimeSessionName: missingKey },
      });
      writeResidentEntries({ [missingKey]: missingEntry }, 1);
      acpSelects.counts.metadata = 0;
      await projection.ensureMaterialized();
      expect(acpSelects.counts.metadata).toBe(0);
      expect(locked()).toBe(true);
    } finally {
      projection?.dispose();
      acpSelects.restore();
    }
  });
});
