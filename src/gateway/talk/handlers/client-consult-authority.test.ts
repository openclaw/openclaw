import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db-lifecycle.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import * as voiceSessionReaders from "../../../talk/client-voice-session-read.js";
import { readVoiceSessionRecord } from "../../../talk/client-voice-session-store.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { registerChatAbortController } from "../../chat-abort.js";
import type { ChatSendInternalOptions } from "../../server-methods/chat-send-options.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { createIdleRelayProvider } from "../relay/index.test-support.js";
import { closeRelaySession, registerTalkRealtimeRelayAgentRun } from "../relay/operations.js";
import { createTalkRealtimeRelaySession } from "../relay/session-create.js";
import { relaySessions } from "../relay/state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { talkClientHandlers } from "./client.js";

const chat = vi.hoisted(() => ({
  current: true,
  dispatched: vi.fn(),
  beforeRegistration: vi.fn(),
}));
// mock-isolation: Exercise consult registration and cancellation without dispatching a real model turn.
vi.mock("../../server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: async (
    request: GatewayRequestHandlerOptions,
    _onAdmissionOwned: unknown,
    options: ChatSendInternalOptions,
  ) => {
    const assertWorkAdmissionCurrent = () => {
      if (!chat.current) {
        throw new Error("Accepted chat was cancelled during registration");
      }
    };
    const assertCurrent = () => {
      assertWorkAdmissionCurrent();
      request.sessionMutationCommitGuard?.();
    };
    let release: void | (() => void) = undefined;
    try {
      assertCurrent();
      await chat.beforeRegistration();
      release = await options.beforeDispatch?.({
        runId: "queued-consult",
        assertCurrent,
        assertWorkAdmissionCurrent,
      });
      assertCurrent();
      chat.dispatched();
      request.respond(true, { runId: "queued-consult", status: "started" });
    } catch (error) {
      release?.();
      request.respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
    }
  },
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const scope = { agentId: "main", sessionKey: "agent:main:consult-authority" };
const voiceSessionId = "consult-authority-voice";
let tempDir: string;
let inWorkerGrant = false;
let workerGrantReads: string[] = [];
let sqlReads: ReturnType<typeof observeSqliteReadSql> | undefined;

describe("voice consult registration authority", () => {
  const tempDirs = useAutoCleanupTempDirTracker((remove) =>
    afterEach(async () => {
      clientVoiceSessionTesting.reset();
      try {
        await cleanupSessionStateForTest({ stateDir: tempDir });
      } finally {
        sqlReads?.restore();
        vi.restoreAllMocks();
        envSnapshot.restore();
        remove();
      }
    }),
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    chat.current = true;
    chat.beforeRegistration.mockReset();
    inWorkerGrant = false;
    workerGrantReads = [];
    tempDir = tempDirs.make("openclaw-consult-authority-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    await replaceSessionEntry(scope, { sessionId: "original-consult-session", updatedAt: 1 });
    await voiceSessions.createOrResumeClientVoiceSession({
      ...scope,
      voiceSessionId,
      origin: "client",
    });
    const reads = observeSqliteReadSql(StatementSync.prototype);
    sqlReads = reads;
    const admit = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (authorize, attachment) =>
        admit((request, grant) => {
          const start = reads.queries.length;
          inWorkerGrant = true;
          try {
            authorize(request, grant);
          } finally {
            inWorkerGrant = false;
            workerGrantReads.push(...reads.queries.slice(start));
          }
        }, attachment),
    );
  });

  it.for([
    { origin: "client", wait: "preparation" },
    { origin: "client", wait: "chat" },
    { origin: "relay", wait: "chat" },
  ] as const)(
    "keeps delegated $origin registration on its source through the real tool-call handler ($wait)",
    async ({ origin, wait }, { signal }) => {
      const originalEnv = { ...process.env };
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      const successor = path.join(tempDir, "successor");
      const config = {
        agents: { defaults: { workspace: path.join(tempDir, "workspace") } },
        session: { store: resolveOpenClawAgentSqlitePath({ agentId: scope.agentId }) },
      };
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => config;
      context.getCommittedRuntimeConfig = () => config;
      const client = { connId: `${origin}-${wait}-delegation-source` };
      const created =
        origin === "relay"
          ? createTalkRealtimeRelaySession({
              context,
              connId: client.connId,
              cfg: config,
              provider: createIdleRelayProvider(),
              providerConfig: {},
              instructions: "brief",
              tools: [],
              controlSource: "transcript",
              sessionTarget: await prepareTalkSessionTarget(config, scope.sessionKey),
            })
          : undefined;
      const relay = created ? relaySessions.get(created.relaySessionId)! : undefined;
      const selectedVoiceSessionId = relay?.id ?? voiceSessionId;
      const waiting = createDeferred();
      const resume = createDeferred();
      let pending: Promise<unknown> | undefined;
      try {
        setTestEnvValue("OPENCLAW_STATE_DIR", successor);
        await voiceSessions.createOrResumeClientVoiceSession({
          ...scope,
          voiceSessionId: selectedVoiceSessionId,
          origin,
        });
        env.restore();
        const params = {
          sessionKey: scope.sessionKey,
          ...(relay ? { relaySessionId: relay.id } : {}),
          ...(wait === "chat" ? { voiceSessionId: selectedVoiceSessionId } : {}),
          callId: "delegated-source-call",
          name: "openclaw_agent_consult",
          args: { question: "Report fixture status" },
        };
        const authorized = resolveSessionMutationAuthorization({
          method: "talk.client.toolCall",
          requestParams: params,
          context,
          client: client as never,
        });
        expect(authorized.error).toBeNull();
        if (wait === "preparation") {
          const lookup = voiceSessionReaders.resolveOpenClientVoiceSessionId;
          vi.spyOn(voiceSessionReaders, "resolveOpenClientVoiceSessionId").mockImplementationOnce(
            async (...args) => {
              waiting.resolve();
              await resume.promise;
              return lookup(...args);
            },
          );
        } else {
          chat.beforeRegistration.mockImplementationOnce(async () => {
            waiting.resolve();
            await resume.promise;
          });
        }
        const respond = vi.fn();
        pending = Promise.resolve(
          talkClientHandlers["talk.client.toolCall"]!({
            req: { type: "req", id: "delegated-source", method: "talk.client.toolCall" },
            params,
            context,
            client,
            respond,
            sessionMutationAuthorization: authorized.authorization,
          } as never),
        );
        await withinTest(
          Promise.race([
            waiting.promise,
            pending.then(() => {
              throw new Error("Tool call ended before source handoff waited");
            }),
          ]),
          signal,
        );
        setTestEnvValue("OPENCLAW_STATE_DIR", successor);
        resume.resolve();
        await pending;
        expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
        expect(chat.dispatched).toHaveBeenCalledOnce();
        expect(
          readVoiceSessionRecord(scope.agentId, selectedVoiceSessionId, { env: originalEnv }),
        ).toMatchObject({
          consultRunIds: ["queued-consult"],
          status: "open",
        });
        expect(readVoiceSessionRecord(scope.agentId, selectedVoiceSessionId)).toMatchObject({
          consultRunIds: [],
          status: "open",
        });
      } finally {
        resume.resolve();
        await pending?.catch(() => {});
        env.restore();
        if (relay) {
          await closeRelaySession(relay, "completed");
        }
        await cleanupSessionStateForTest({ stateDir: successor, rootPath: successor });
      }
    },
  );

  it.for(["registered", "failed"] as const)(
    "hands off cleanup before stale delegated handler refusal (%s)",
    async (successor, { signal }) => {
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => ({});
      const client = { connId: "replacement-registration" };
      const created = createTalkRealtimeRelaySession({
        context,
        connId: client.connId,
        cfg: {},
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        controlSource: "transcript",
        sessionTarget: await prepareTalkSessionTarget({}, scope.sessionKey),
      });
      const relay = relaySessions.get(created.relaySessionId)!;
      const runId = "queued-consult";
      const registration = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId,
        sessionId: "original-consult-session",
        sessionKey: scope.sessionKey,
        timeoutMs: 60_000,
      });
      const held = createDeferred();
      const resume = createDeferred();
      const register = voiceSessions.registerClientVoiceConsultRun;
      vi.spyOn(voiceSessions, "registerClientVoiceConsultRun").mockImplementationOnce(
        async (params) => {
          const release = await register(params);
          held.resolve();
          await resume.promise;
          return release;
        },
      );
      const params = {
        sessionKey: scope.sessionKey,
        relaySessionId: relay.id,
        voiceSessionId: relay.id,
        callId: "replacement-registration-call",
        name: "openclaw_agent_consult",
        args: { question: "Report fixture status" },
      };
      const authorized = resolveSessionMutationAuthorization({
        method: "talk.client.toolCall",
        requestParams: params,
        context,
        client: client as never,
      });
      const respond = vi.fn();
      const pending = talkClientHandlers["talk.client.toolCall"]!({
        req: { type: "req", id: "replacement-registration", method: "talk.client.toolCall" },
        params,
        context,
        client,
        respond,
        sessionMutationAuthorization: authorized.authorization,
      } as never);
      try {
        await withinTest(held.promise, signal);
        const replacement = {
          relaySessionId: relay.id,
          connId: relay.connId,
          sessionKey: scope.sessionKey,
          runId,
          callId: params.callId,
        };
        const current =
          successor === "registered"
            ? await registerTalkRealtimeRelayAgentRun(replacement)
            : undefined;
        if (successor === "failed") {
          await expect(
            registerTalkRealtimeRelayAgentRun({
              ...replacement,
              registerVoice: async () => {
                throw new Error("replacement registration refused");
              },
            }),
          ).rejects.toThrow("replacement registration refused");
        }
        resume.resolve();
        await pending;
        expect(respond.mock.lastCall?.[0]).toBe(false);
        expect(chat.dispatched).not.toHaveBeenCalled();
        if (current) {
          expect(current.isCurrent()).toBe(true);
          expect(voiceSessions.resolveClientVoiceRunBinding(runId)).toBeDefined();
          expect(registration.controller.signal.aborted).toBe(false);
          current.release();
        } else {
          expect(relay.activeAgentRuns.size).toBe(0);
          expect(relay.activeAgentToolCalls.size).toBe(0);
          expect(voiceSessions.resolveClientVoiceRunBinding(runId)).toBeUndefined();
          expect(registration.controller.signal.aborted).toBe(true);
        }
      } finally {
        resume.resolve();
        await pending;
        registration.cleanup();
        await closeRelaySession(relay, "completed");
      }
    },
  );

  it.each([false, true])(
    "reopens a cold tool-call target with its SDK guard classified (sdk=%s)",
    async (sdk) => {
      await cleanupSessionStateForTest({ stateDir: tempDir });
      closeOpenClawAgentDatabasesForTest(tempDir);
      workerGrantReads = [];
      const config = { agents: { defaults: { workspace: path.join(tempDir, "workspace") } } };
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => config;
      context.getCommittedRuntimeConfig = () => config;
      const params = {
        sessionKey: scope.sessionKey,
        voiceSessionId,
        callId: "cold-consult-call",
        name: "openclaw_agent_consult",
        args: { question: "Report the fixture status" },
      };
      const authorized = resolveSessionMutationAuthorization({
        method: "talk.client.toolCall",
        requestParams: params,
        context,
        client: null,
      });
      expect(authorized.error).toBeNull();
      expect(getOpenClawAgentDatabaseIfOpen(scope)).toBeUndefined();
      const targetPath = resolveOpenClawAgentSqlitePath(scope);
      const targetPaths = new Set([
        targetPath,
        readDatabasePathIdentitySync(targetPath).canonicalPath,
      ]);
      const coldSchemaSql: string[] = [];
      const observeColdSchemaSql = (database: DatabaseSync, sql: string) => {
        if (
          targetPaths.has(database.location() ?? "") &&
          !getOpenClawAgentDatabaseIfOpen(scope) &&
          /\b(?:sqlite_master|sqlite_schema|(?:pragma_)?(?:table_(?:xinfo|info)|index_(?:list|xinfo|info)|foreign_key_(?:list|check)|quick_check|integrity_check)|create\s+(?:(?:unique|virtual)\s+)?(?:table|index|trigger|view)|alter\s+table|drop\s+(?:table|index|trigger|view))\b/i.test(
            sql,
          )
        ) {
          coldSchemaSql.push(sql);
        }
      };
      // oxlint-disable-next-line typescript/unbound-method -- Forward with the intercepted database receiver.
      const prepare = DatabaseSync.prototype.prepare;
      vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        observeColdSchemaSql(this, sql);
        return prepare.call(this, sql);
      });
      // oxlint-disable-next-line typescript/unbound-method -- Forward with the intercepted database receiver.
      const execute = DatabaseSync.prototype.exec;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        observeColdSchemaSql(this, sql);
        return execute.call(this, sql);
      });
      let checkedWhileCold = false;
      const respond = vi.fn();
      await talkClientHandlers["talk.client.toolCall"]!({
        req: { type: "req", id: "cold-consult", method: "talk.client.toolCall" },
        params,
        context,
        client: null,
        respond,
        sessionMutationAuthorization: authorized.authorization,
        ...(sdk
          ? {
              sessionMutationCommitGuard: () => {
                expect(inWorkerGrant).toBe(false);
                checkedWhileCold ||= getOpenClawAgentDatabaseIfOpen(scope) === undefined;
              },
            }
          : {}),
      } as never);
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
      expect(chat.dispatched).toHaveBeenCalledOnce();
      expect(coldSchemaSql).toEqual([]);
      expect(checkedWhileCold).toBe(sdk);
      expect(workerGrantReads.filter(isSessionEntryDataSql)).toEqual([]);
    },
  );

  it.for(["current", "worker-current", "sdk", "session", "chat"] as const)(
    "publishes only a currently authorized queued consult (%s)",
    async (revoked, { signal }) => {
      const config = { agents: { defaults: { workspace: path.join(tempDir, "workspace") } } };
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => config;
      context.getCommittedRuntimeConfig = () => config;
      const params = {
        sessionKey: scope.sessionKey,
        voiceSessionId,
        callId: "queued-consult-call",
        name: "openclaw_agent_consult",
        args: { question: "Report the fixture status" },
      };
      const authorized = resolveSessionMutationAuthorization({
        method: "talk.client.toolCall",
        requestParams: params,
        context,
        client: null,
      });
      expect(authorized.error).toBeNull();
      const queued = createDeferred();
      const entered = createDeferred();
      const releaseQueue = createDeferred();
      let sdkCurrent = true;
      let nativeSdkCommitObserved = false;
      let blocker: Promise<void> | undefined;
      const register = voiceSessions.registerClientVoiceConsultRun;
      vi.spyOn(voiceSessions, "registerClientVoiceConsultRun").mockImplementation(async (input) => {
        blocker = runOpenClawAgentWriteAdmission(scope, async () => {
          entered.resolve();
          await releaseQueue.promise;
        });
        await entered.promise;
        const pending = register(input);
        queued.resolve();
        return await pending;
      });
      const respond = vi.fn();
      const running = talkClientHandlers["talk.client.toolCall"]!({
        req: { type: "req", id: "consult-authority", method: "talk.client.toolCall" },
        params,
        context,
        client: null,
        respond,
        sessionMutationAuthorization: authorized.authorization,
        ...(revoked === "sdk" || revoked === "current"
          ? {
              sessionMutationCommitGuard: () => {
                expect(inWorkerGrant).toBe(false);
                expect(loadSessionEntry(scope)?.sessionId).toBe("original-consult-session");
                nativeSdkCommitObserved ||=
                  getOpenClawAgentDatabaseIfOpen(scope)?.db.isTransaction === true;
                if (!sdkCurrent) {
                  throw new Error("SDK consult authority was revoked");
                }
              },
            }
          : {}),
      } as never);
      try {
        await withinTest(
          Promise.race([
            queued.promise,
            Promise.resolve(running).then(() => {
              throw new Error("Consult ended before real registration was queued");
            }),
          ]),
          signal,
        );
        expect(chat.dispatched).not.toHaveBeenCalled();
        if (revoked === "sdk") {
          sdkCurrent = false;
        } else if (revoked === "session") {
          replaceSessionEntrySync(scope, { sessionId: "revoked-consult-session", updatedAt: 2 });
        } else if (revoked === "chat") {
          chat.current = false;
        }
        releaseQueue.resolve();
        await running;
        await blocker;
        const record = clientVoiceSessionTesting.readRecord(scope.agentId, voiceSessionId);
        expect(record).toBeDefined();
        if (revoked === "worker-current" || revoked === "session" || revoked === "chat") {
          // Same-store authority must consume the mutation's supplied row facts.
          expect(workerGrantReads.filter(isSessionEntryDataSql)).toEqual([]);
        }
        if (revoked === "current" || revoked === "worker-current") {
          expect(record?.consultRunIds).toEqual(["queued-consult"]);
          expect(voiceSessions.resolveClientVoiceRunBinding("queued-consult")).toBeDefined();
          expect(chat.dispatched).toHaveBeenCalledOnce();
          expect(respond.mock.lastCall?.[0]).toBe(true);
          expect(nativeSdkCommitObserved).toBe(revoked === "current");
        } else {
          expect(record?.consultRunIds).toEqual([]);
          expect(voiceSessions.resolveClientVoiceRunBinding("queued-consult")).toBeUndefined();
          expect(chat.dispatched).not.toHaveBeenCalled();
          expect(respond.mock.lastCall?.[0]).toBe(false);
        }
      } finally {
        releaseQueue.resolve();
        await running;
        await blocker;
      }
    },
  );

  it("checks a process-held source inside the durable native voice transaction", async () => {
    const sessionKey = "agent:main:dashboard:incognito-native-voice";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      { sessionId: "native-voice-source", updatedAt: 1, incognito: true },
    );
    const authorization = resolveSessionMutationAuthorization({
      method: "talk.client.create",
      requestParams: { sessionKey },
      context: { getRuntimeConfig: () => ({}) } as GatewayRequestHandlerOptions["context"],
      client: null,
    });
    expect(authorization.error).toBeNull();
    const target = authorization.authorization?.talkSessionTarget;
    if (!target) {
      throw new Error("Expected a prepared incognito Talk source");
    }
    const source = retainOpenClawAgentDatabaseReadOnly({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    if (!source.found) {
      throw new Error("Expected the process-held source to remain open");
    }
    let nativeAuthorityObserved = false;
    const reads = trackSqliteStatementExecutions(source.database.db, ["source"], (sql) => {
      if (!isSessionEntryDataSql(sql)) {
        return null;
      }
      return "source";
    });
    try {
      await voiceSessions.createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId: "native-source-voice",
        origin: "client",
        source: {
          storePath: target.storePath,
          assertCurrent: composeSessionSourceAssertion(
            [authorization.authorization!.assertCurrent],
            (assertSource) => {
              assertSource();
              nativeAuthorityObserved ||=
                getOpenClawAgentDatabaseIfOpen({ agentId: "main" })?.db.isTransaction === true;
            },
          ),
        },
      });
      expect(reads.counts.source).toBeGreaterThan(0);
      expect(nativeAuthorityObserved).toBe(true);
      expect(clientVoiceSessionTesting.readRecord("main", "native-source-voice")).toMatchObject({
        sessionKey,
        status: "open",
      });
    } finally {
      reads.restore();
      source.claim.release();
    }
  });

  it.each(["foreign", "incognito"] as const)(
    "prepares a cold native target for a %s requester without caller-thread schema work",
    async (kind) => {
      const sourceKey =
        kind === "incognito" ? "agent:main:dashboard:incognito-cold-native" : scope.sessionKey;
      if (kind === "incognito") {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: sourceKey },
          { sessionId: "cold-native-source", updatedAt: 1, incognito: true },
        );
      }
      const authorized = resolveSessionMutationAuthorization({
        method: "talk.client.create",
        requestParams: { sessionKey: sourceKey },
        context: { getRuntimeConfig: () => ({}) } as GatewayRequestHandlerOptions["context"],
        client: null,
      });
      expect(authorized.error).toBeNull();
      const source =
        kind === "incognito"
          ? retainOpenClawAgentDatabaseReadOnly({
              agentId: "main",
              path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
            })
          : undefined;
      if (source && !source.found) {
        throw new Error("Expected the process-held source to remain open");
      }
      const target = {
        agentId: `cold-native-${kind}`,
        sessionKey: `agent:cold-native-${kind}:main`,
      };
      const targetPath = resolveOpenClawAgentSqlitePath(target);
      const targetPaths = new Set([
        targetPath,
        readDatabasePathIdentitySync(targetPath).canonicalPath,
      ]);
      expect(existsSync(targetPath)).toBe(false);
      let nativeAuthorityObserved = false;
      let preparedAuthorityObserved = false;
      const schemaSql: string[] = [];
      sqlReads?.restore();
      sqlReads = undefined;
      const sql = observeHostDataSql((query, database) => {
        if (
          database &&
          targetPaths.has(database.location() ?? "") &&
          /\b(?:create\s+(?:(?:unique|virtual)\s+)?(?:table|index|trigger|view)|alter\s+table|drop\s+(?:table|index|trigger|view)|quick_check|integrity_check)\b/i.test(
            query,
          )
        ) {
          schemaSql.push(query);
        }
      });
      try {
        await voiceSessions.createOrResumeClientVoiceSession({
          ...target,
          voiceSessionId: "cold-native-voice",
          origin: "client",
          requester: composeSessionSourceAssertion(
            [authorized.authorization!.assertCurrent],
            (assertSource) => {
              expect(inWorkerGrant).toBe(false);
              assertSource();
              nativeAuthorityObserved ||=
                getOpenClawAgentDatabaseIfOpen(target)?.db.isTransaction === true;
            },
            {
              preparedCheck: (assertSource) => {
                preparedAuthorityObserved ||= inWorkerGrant;
                assertSource();
              },
            },
          ),
        });
        expect(schemaSql).toEqual([]);
        expect(preparedAuthorityObserved).toBe(true);
        expect(nativeAuthorityObserved).toBe(true);
        expect(
          clientVoiceSessionTesting.readRecord(target.agentId, "cold-native-voice"),
        ).toMatchObject({
          sessionKey: target.sessionKey,
          status: "open",
        });
      } finally {
        sql.restore();
        source?.claim.release();
      }
    },
  );
});
