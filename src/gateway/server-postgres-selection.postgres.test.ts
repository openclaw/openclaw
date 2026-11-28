import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { expect, it } from "vitest";
import type { HelloOk, SessionsSearchResult } from "../../packages/gateway-protocol/src/index.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import { withTranscriptWriteSequence } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  markCanonicalSessionValidationPending,
} from "../config/sessions/session-canonical-key.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { installGatewayDatabaseEngine } from "./server-database-engine.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const DSN_ENV = "OPENCLAW_PG_SELECTION_DSN";

it.skipIf(!connection)(
  "exposes replayed PostgreSQL mirrors through authenticated Gateway reads and preserves API writes across restart",
  async ({ signal }) => {
    const prefix = `gw_selection_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const nodeExecutable = resolveTestNodeExecPath();
    const databaseClient = new pg.Client({ connectionString: connection });
    let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let connected = false;
    await runQaGatewayFixture(
      async () => {
        await databaseClient.connect();
        connected = true;
        instance = await createOpenClawTestInstance({
          name: "postgres-selection",
          signal,
          entrypoint: resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli),
            nodeExecutable,
          ),
          gatewayCommandPrefix: [nodeExecutable],
          env: {
            [DSN_ENV]: connection,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_NO_RESPAWN: "1",
            NODE_DISABLE_COMPILE_CACHE: "1",
          },
          config: {
            database: {
              engine: "postgres",
              postgres: {
                connection: { source: "env", provider: "default", id: DSN_ENV },
                schemaPrefix: prefix,
              },
            },
            gateway: { mode: "local", controlUi: { enabled: false } },
            agents: {
              ownership: "explicit",
              defaults: { skipBootstrap: true },
              entries: { main: {} },
            },
            plugins: { enabled: false },
            memory: { search: { enabled: false } },
            cron: { enabled: false, triggers: { enabled: false } },
            hooks: { enabled: false },
            skills: { load: { watch: false } },
          },
        });
        instance.state.applyEnv();
        delete instance.env.VITEST;
        delete instance.env.NODE_ENV;
        const connect = async () => {
          let hello: HelloOk | undefined;
          const next = await connectGatewayClient({
            url: instance!.url,
            token: instance!.gatewayToken,
            clientName: "cli",
            mode: "cli",
            role: "operator",
            scopes: ["operator.admin"],
            signal,
            onHelloOk: (value) => {
              hello = value;
            },
          });
          client = next;
          expect(hello?.auth.scopes).toContain("operator.admin");
          expect(hello?.auth.deviceToken).toBeTruthy();
          return next;
        };
        await instance.startGateway();
        let api = await connect();
        const keys = ["agent:main:selection-one", "agent:main:selection-two"];
        const sessions = [];
        for (const key of keys) {
          const created = await api.request<{ key: string; sessionId: string }>("sessions.create", {
            key,
            agentId: "main",
          });
          expect(created.key).toBe(key);
          expect(created.sessionId).toBeTruthy();
          sessions.push(created);
        }
        await api.stopAndWait();
        client = undefined;
        await instance.stopGateway();
        const preflight = await runStartupConfigPreflight({ gateway: true, observe: false });
        try {
          expect(preflight.snapshot.valid).toBe(true);
          await installGatewayDatabaseEngine(preflight.snapshot, preflight.databaseEngineSelection);
        } finally {
          await preflight.pluginCache?.[Symbol.asyncDispose]();
        }
        const storePath = resolveOpenClawAgentSqlitePath({
          agentId: "main",
          env: instance.state.env,
        });
        const scopes = sessions.map(({ key, sessionId }) => ({
          agentId: "main",
          sessionKey: key,
          sessionId,
          storePath,
        }));
        const runId = "selection-source-run";
        const idempotencyKeys = ["selection-first", "selection-last"];
        const text = "龘 selection mirror";
        const append = (index: number, slot: number) =>
          appendAssistantMessageToSessionTranscript({
            ...scopes[index]!,
            expectedSessionId: scopes[index]!.sessionId,
            config: preflight.snapshot.config,
            text: slot === 0 ? "selection first mirror" : text,
            eventId: `selection-message-${index}-${slot}`,
            idempotencyKey: index === 0 ? idempotencyKeys[slot] : "selection-other",
            ...(slot === 1 ? { runId } : {}),
          });
        const first = await append(0, 0);
        const last = await append(0, 1);
        const other = await append(1, 1);
        expect(first.ok && last.ok && other.ok).toBe(true);
        if (!first.ok || !last.ok || !other.ok) {
          throw new Error("Synthetic mirror append failed");
        }
        expect(first.anchor).toBeDefined();
        expect(last.anchor).toBeDefined();
        const replay = await append(0, 1);
        expect(replay).toMatchObject({ ok: true, messageId: last.messageId, anchor: last.anchor });
        await waitForSessionTranscriptProjection(scopes[0]!, signal);
        await waitForSessionTranscriptProjection(scopes[1]!, signal);
        const requested = [
          idempotencyKeys[0]!,
          ...Array.from({ length: 899 }, (_, index) => `absent-${index}`),
          idempotencyKeys[1]!,
        ];
        const facts = await withTranscriptWriteSequence(scopes[0]!, (writer) =>
          writer.readMessageFacts({ idempotencyKeys: requested, sourceRunId: runId }),
        );
        expect([...facts.existingIdempotencyKeys]).toEqual(idempotencyKeys);
        expect([...facts.anchorsByIdempotencyKey.values()]).toEqual([first.anchor, last.anchor]);
        expect(facts.sourceEvents).toEqual([expect.objectContaining({ id: last.messageId })]);
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          markCanonicalSessionValidationPending(database, [keys[1]!]);
          assertCanonicalSqliteSessionKeysCurrent(database);
          const scope = { agentId: "main", storePath, includeParticipants: false };
          expect(
            database.db
              .prepare(
                "SELECT count(*) AS count FROM session_canonical_validation_pending WHERE session_key = ?",
              )
              .get(keys[1]!),
          ).toEqual({ count: 1 });
          for (const clone of [true, false]) {
            expect(
              listSessionEntriesCore({ ...scope, clone, sessionKeys: [keys[0]!] }).map(
                (entry) => entry.sessionKey,
              ),
            ).toEqual([keys[0]]);
          }
          const state = database.db
            .prepare(
              "SELECT indexed_seq, needs_rebuild, (SELECT max(seq) FROM transcript_events WHERE session_id = ?) AS latest FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(scopes[0]!.sessionId, scopes[0]!.sessionId);
          expect(state?.needs_rebuild).toBe(0);
          expect(state?.indexed_seq).toBe(state?.latest);
        });
        await cleanupSessionStateForTest({
          stateDir: instance.stateDir,
          rootPath: instance.state.root,
        });
        await instance.startGateway();
        api = await connect();
        const history = () =>
          api.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: keys[0],
            agentId: "main",
            limit: 100,
          });
        const original = await history();
        expect(original.messages.map(readChatHistoryMessageId)).toEqual([
          first.messageId,
          last.messageId,
        ]);
        const selected = async (index: number) =>
          api.request<SessionsSearchResult>("sessions.search", {
            agentId: "main",
            sessionKeys: [keys[index]],
            query: "龘",
            limit: 25,
          });
        for (const [index, message] of [last, other].entries()) {
          const result = await selected(index);
          expect(result.truncated).not.toBe(true);
          expect(result.indexing).not.toBe(true);
          expect(result.results.every((hit) => Number.isFinite(hit.score))).toBe(true);
          expect(
            result.results.map((hit) => [hit.sessionKey, hit.sessionId, hit.messageId]),
          ).toEqual([[keys[index], sessions[index]!.sessionId, message.messageId]]);
        }
        const global = await api.request<SessionsSearchResult>("sessions.search", {
          query: "龘",
          limit: 25,
          recall: { requesterAgentId: "main", requesterSessionKey: keys[0] },
        });
        expect(global.truncated).not.toBe(true);
        expect(global.indexing).not.toBe(true);
        expect(global.results.every((hit) => Number.isFinite(hit.score))).toBe(true);
        expect(
          global.results
            .map((hit) => [hit.sessionKey, hit.sessionId, hit.messageId])
            .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
        ).toEqual(
          [
            [keys[0], sessions[0]!.sessionId, last.messageId],
            [keys[1], sessions[1]!.sessionId, other.messageId],
          ].toSorted(([a], [b]) => String(a).localeCompare(String(b))),
        );
        const injected = await api.request<{ ok: true; messageId: string }>("chat.inject", {
          sessionKey: keys[0],
          agentId: "main",
          message: "selection injected persistence",
        });
        expect(injected.ok).toBe(true);
        expect(injected.messageId).toBeTruthy();
        await api.stopAndWait();
        client = undefined;
        await instance.stopGateway();
        await instance.startGateway();
        api = await connect();
        expect((await history()).messages.map(readChatHistoryMessageId)).toEqual([
          first.messageId,
          last.messageId,
          injected.messageId,
        ]);
      },
      () => client?.stopAndWait(),
      () => instance?.cleanup(),
      () => (connected ? dropPostgresTestSchemas(databaseClient, prefix) : undefined),
      () => databaseClient.end(),
      () => resetDatabaseEngineSelectionForTest(),
    );
  },
  180_000,
);
