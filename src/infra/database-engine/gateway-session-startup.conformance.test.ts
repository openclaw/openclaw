import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { scanDoctorSessionEntryRecords } from "../../commands/doctor/shared/session-entry-rewrite.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  appendTranscriptEvent,
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { markCanonicalSessionValidationPending } from "../../config/sessions/session-canonical-key.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readSessionTaskArchivePageReadOnly } from "../../config/sessions/session-history.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeCronRunErrorText } from "../../cron/service/execution-errors.js";
import { handleChatHistoryRequest } from "../../gateway/server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "../../gateway/server-methods/chat-history.test-helpers.js";
import {
  respondChatSendAdmissionError,
  resolveChatSendStorageErrorMessage,
} from "../../gateway/server-methods/chat-send-admission-errors.js";
import { identifiedClient } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import type { RespondFn } from "../../gateway/server-methods/types.js";
import { prepareGatewayStartupSessions } from "../../gateway/server-startup-session-migration.js";
import { disposeSessionReadContexts } from "../../gateway/session-read-contexts.test-support.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission as admitted } from "./admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";

describe
  .skipIf(!mixedAgentConnection)
  .each(mixedAgentPairs.filter(({ stateEngine, agentEngine }) => stateEngine === agentEngine))(
  "$agentEngine Gateway session startup",
  ({ stateEngine, agentEngine }) => {
    const pair = useMixedAgentPair(stateEngine, agentEngine);

    it.each(["main", "qa"])(
      "admits fresh %s then repairs and retains its sessions across restart",
      async (agentId) => {
        const stateDir = path.join(pair.root, agentId);
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        await captureRuntimeConfigAsyncReader()();
        const env = { ...process.env };
        const options = { agentId, env };
        const database = () => openOpenClawAgentDatabase(options);
        const read = (scope: Parameters<typeof loadSessionEntryReadOnly>[0]) =>
          admitted(() => loadSessionEntryReadOnly(scope));
        const cfg = {
          agents: {
            ...(agentId === "main" ? { ownership: "explicit" as const } : {}),
            entries: { [agentId]: {} },
          },
        };
        const close = async () => {
          admitted(() => closeOpenClawAgentDatabases(stateDir));
          await cleanupSessionStateForTest({ stateDir });
        };
        const prepare = async () => {
          const log = { info: vi.fn(), warn: vi.fn() };
          const databases = await prepareGatewayStartupSessions({ cfg, env, log });
          expect(databases).toHaveLength(1);
          databases[0]?.assertCurrent();
        };
        admitted(database);
        await close();
        await prepare();
        await close();
        const scope = { agentId, env, sessionKey: `agent:${agentId}:main` };
        const legacyScope = { ...scope, sessionKey: `agent:${agentId}:dashboard:running` };
        await upsertSessionEntryCore(scope, {
          sessionId: "retained-startup-session",
          updatedAt: 1,
        });
        const legacy = await upsertSessionEntryCore(legacyScope, {
          sessionId: "retained-running-session",
          status: "done",
        });
        const legacyJson = JSON.stringify({ ...legacy, status: "running" });
        admitted(() => {
          const store = database();
          store.db
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(`${legacyJson.slice(0, -1)},"opaque":9007199254740993}`, legacyScope.sessionKey);
          // Legacy repair clears its own row; retain normal work for the pooled validator.
          markCanonicalSessionValidationPending(store, [scope.sessionKey, legacyScope.sessionKey]);
        });
        await close();

        for (let boot = 0; boot < 2; boot++) {
          await prepare();
          expect(read(scope)).toMatchObject({
            sessionId: "retained-startup-session",
          });
          expect(read(legacyScope)).toMatchObject({
            sessionId: "retained-running-session",
            status: "interrupted",
            abortedLastRun: true,
          });
          admitted(() => {
            const { db } = database();
            expect(
              db
                .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
                .get(legacyScope.sessionKey)?.entry_json,
            ).toMatch(/"opaque"\s*:\s*9007199254740993/);
            expect(
              db.prepare("SELECT session_key FROM session_canonical_validation_pending").all(),
            ).toEqual([]);
          });
          await close();
        }
      },
    );

    it("filters legacy JSON without losing duplicate-key precedence or rejecting scalar rows", () => {
      admitted(() => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: pair.root };
        const database = openOpenClawAgentDatabase({ agentId: "scan-proof", env });
        const insert = database.db.prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
        );
        for (const [key, json] of [
          ["clean", '{"status":"done"}'],
          ["invalid", "{"],
          ["scalar", '"running"'],
          ["array", '["running"]'],
          ["duplicate", '{"status":"running","status":"done"}'],
          ["running", '{"status":"running"}'],
          ["boolean", '{"pendingFinalDelivery":true}'],
          ["string", '{"pendingFinalDelivery":"true"}'],
        ] as const) {
          insert.run(key, key, json);
        }
        const selected: Array<{ sessionKey: string; entry: Record<string, unknown> }> = [];
        scanDoctorSessionEntryRecords(
          { agentId: "scan-proof", storePath: database.path, env },
          (record) => selected.push(record),
          readDatabasePathIdentitySync(database.path),
        );
        expect(
          selected.toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
        ).toEqual([
          { sessionKey: "boolean", entry: { pendingFinalDelivery: true } },
          { sessionKey: "duplicate", entry: { status: "done" } },
          { sessionKey: "running", entry: { status: "running" } },
        ]);
      });
    });
  },
);

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} session archives through a state directory alias`,
    () => {
      const pair = useMixedAgentPair(engine, engine);

      it("serves retained history and then archives through the alias", async () => {
        const stateAlias = path.join(pair.root, "state-alias");
        fs.symlinkSync(
          fs.realpathSync.native(pair.root),
          stateAlias,
          process.platform === "win32" ? "junction" : "dir",
        );
        vi.stubEnv("OPENCLAW_STATE_DIR", stateAlias);
        const runId = randomUUID();
        const scope = {
          agentId: "main",
          sessionKey: `agent:main:cron:${randomUUID()}`,
          sessionId: randomUUID(),
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
        };
        try {
          await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
          await appendTranscriptEvent(scope, {
            type: "session",
            version: 3,
            id: scope.sessionId,
          });
          await appendTranscriptMessage(scope, {
            eventId: "input",
            parentId: null,
            message: { role: "user", content: "Synthetic cron request" },
          });
          await appendTranscriptMessage(scope, {
            eventId: "answer",
            parentId: "input",
            message: {
              role: "assistant",
              content: "Synthetic cron answer",
              __openclaw: { runId },
            },
          });
          await waitForSessionTranscriptProjection(scope);
          const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
          config.plugins = { enabled: false };
          setRuntimeConfigSnapshot(config, config);
          const context = await createHistoryReadContext({ getRuntimeConfig: () => config });
          const client = admitted(() => identifiedClient("archive-alias-reader"));
          client.connect.scopes = ["operator.read", "operator.admin"];
          const respond = vi.fn<RespondFn>();
          // cron.history retains its exact run while the reusable base session may advance.
          await handleChatHistoryRequest({
            method: "chat.history",
            req: { type: "req", id: runId, method: "chat.history" },
            params: { sessionKey: scope.sessionKey, limit: 10 },
            retainedTranscript: {
              sessionId: scope.sessionId,
              verifyRetainedState: async () => true,
            },
            context,
            client,
            respond,
            isWebchatConnect: () => false,
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({ content: "Synthetic cron answer" }),
              ]),
            }),
          );
          await disposeSessionReadContexts();
          // Gateway session writes need no retained main-thread database handle.
          await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
          const deleted = await deleteSessionEntryLifecycle({
            storePath: scope.storePath,
            archiveTranscript: true,
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          });
          expect(deleted.deleted).toBe(true);
          expect(deleted.archivedTranscripts).toEqual([
            expect.objectContaining({
              sessionId: scope.sessionId,
              archivedPath: expect.any(String),
            }),
          ]);
          expect(await readSessionEntryInWorker(scope)).toBeUndefined();
          expect(await loadTranscriptEvents(scope)).toEqual([]);
          const page = await readSessionTaskArchivePageReadOnly(scope, { runId, limit: 1 });
          expect(page?.entries).toHaveLength(1);
          expect(page?.entries[0]).toMatchObject({
            event: { id: "answer", message: { content: "Synthetic cron answer" } },
          });
          expect(page?.binding.sessionId).toBe(scope.sessionId);
        } finally {
          await disposeSessionReadContexts();
          await cleanupSessionStateForTest({ stateDir: stateAlias });
        }
      });
    },
  );
}

describe.skipIf(!mixedAgentConnection)("PostgreSQL failures at the chat and cron surfaces", () => {
  const pair = useMixedAgentPair("sqlite", "postgres");

  it.for(["terminate", "cancel"] as const)(
    "preserves the %s outcome from the transcript worker through client rendering",
    { timeout: 60_000 },
    async (fault, { signal }) => {
      const database = admitted(() => openOpenClawAgentDatabase({ agentId: "main" }));
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: `agent:main:postgres-${fault}-${randomUUID()}`,
        sessionId: randomUUID(),
      };
      const append = (customType: string, data: Record<string, unknown> = {}) =>
        appendTranscriptEvent(scope, { type: "custom", id: randomUUID(), customType, data });
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
      await appendTranscriptEvent(scope, { type: "session", version: 3, id: scope.sessionId });
      const config = JSON.parse(
        fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"),
      ) as OpenClawConfig;
      const admin = new Client({ connectionString: mixedAgentConnection });
      const locker = new Client({ connectionString: mixedAgentConnection });
      let write: Promise<PromiseSettledResult<boolean>> | undefined;
      try {
        await Promise.all([admin.connect(), locker.connect()]);
        const prefix = config.database!.postgres!.schemaPrefix!;
        const schemas = await admin.query<{ table_schema: string }>(
          "SELECT table_schema FROM information_schema.tables WHERE left(table_schema, $1) = $2 AND table_name = 'transcript_events'",
          [prefix.length + 7, `${prefix}_agent_`],
        );
        expect(schemas.rows).toHaveLength(1);
        const table = `"${schemas.rows[0]!.table_schema.replaceAll('"', '""')}".transcript_events`;
        await locker.query("BEGIN");
        await locker.query(`LOCK TABLE ${table} IN SHARE MODE`);
        const lockerPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        write = append("outcome-proof", { fault }).then(
          (value) => ({ status: "fulfilled", value }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
        let blockedPid: number | undefined;
        const deadline = Date.now() + 15_000;
        while (!blockedPid && Date.now() < deadline) {
          const result = await admin.query<{ pid: number }>(
            "SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid WHERE a.state = 'active' AND a.query ILIKE '%INSERT INTO%' AND NOT l.granted AND l.relation = $1::regclass AND $2 = ANY(pg_blocking_pids(a.pid))",
            [table, lockerPid],
          );
          blockedPid = result.rows[0]?.pid;
          if (!blockedPid) {
            await delay(20);
          }
        }
        expect(blockedPid, "transcript worker reached its PostgreSQL write").toBeDefined();
        const injected = await admin.query<{ injected: boolean }>(
          fault === "terminate"
            ? "SELECT pg_terminate_backend($1) AS injected"
            : "SELECT pg_cancel_backend($1) AS injected",
          [blockedPid],
        );
        expect(injected.rows[0]?.injected).toBe(true);
        await locker.query("ROLLBACK");
        const outcome = await withinTest(write, signal);
        if (outcome.status !== "rejected") {
          throw new Error("Expected the native write to fail");
        }
        const failure: unknown = outcome.reason;
        const code = fault === "terminate" ? "session_actor_reconciliation" : "57014";

        const respond = vi.fn<RespondFn>();
        const onStorageError = vi.fn<(message: string) => void>();
        respondChatSendAdmissionError(failure, respond, onStorageError);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            retryable: false,
            details: { code },
          }),
        );
        const response = expectDefined(respond.mock.calls[0]?.[2], "chat error response");
        for (const rendered of [
          response.message,
          resolveChatSendStorageErrorMessage(failure),
          onStorageError.mock.calls[0]?.[0],
          normalizeCronRunErrorText(failure),
        ]) {
          expect(rendered).toMatch(/check|reopen|retry/i);
          expect(rendered).toMatch(fault === "terminate" ? /confirm|saved/i : /cancel|timeout/i);
        }
        expect(await append("recovered-write")).toBe(true);
      } finally {
        await locker.query("ROLLBACK").catch(() => {});
        if (write) {
          await write;
        }
        await Promise.all([admin.end(), locker.end()]);
        await cleanupSessionStateForTest({ stateDir: pair.root });
      }
    },
  );
});
