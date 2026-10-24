import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/io.runtime.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import * as voiceSessionReaders from "../../../talk/client-voice-session-read.js";
import { readVoiceSessionRecord } from "../../../talk/client-voice-session-store.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { registerChatAbortController } from "../../chat-abort.js";
import type { ChatSendInternalOptions } from "../../server-methods/chat-send-options.js";
import type {
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "../../server-methods/types.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "../../session-sharing-authorization-async.js";
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
const authorizations: SessionMutationAuthorization[] = [];

function consultContext(
  config: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(tempDir, "workspace") } },
  },
) {
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = context.getCommittedRuntimeConfig = () => config;
  return context;
}

async function authorizeConsult(
  params: Record<string, unknown>,
  context: GatewayRequestHandlerOptions["context"],
  client: GatewayRequestHandlerOptions["client"] = null,
  method = "talk.client.toolCall",
) {
  const authorized = await resolveSessionMutationAuthorizationAsync({
    method,
    requestParams: params,
    context,
    client,
  });
  if (authorized.authorization) {
    authorizations.push(authorized.authorization);
  }
  expect(authorized.error).toBeNull();
  return authorized;
}

function consultParams(callId: string) {
  return {
    sessionKey: scope.sessionKey,
    voiceSessionId,
    callId,
    name: "openclaw_agent_consult",
    args: { question: "Report the fixture status" },
  };
}

function registerConsult(
  sessionTarget: Awaited<ReturnType<typeof prepareTalkSessionTarget>>,
  ownerConnId: string,
) {
  return registerChatAbortController({
    target: captureSessionTarget({
      storeScope: sessionTarget.storePath,
      sessionKey: sessionTarget.canonicalKey,
      agentId: sessionTarget.agentId,
      incarnation: "original-consult-session",
    }),
    runId: "queued-consult",
    sessionId: "original-consult-session",
    sessionKey: scope.sessionKey,
    ownerConnId,
    timeoutMs: 60_000,
  });
}

function toolCall(
  params: Record<string, unknown>,
  context: GatewayRequestHandlerOptions["context"],
  authorization: SessionMutationAuthorization | undefined,
  client: GatewayRequestHandlerOptions["client"] = null,
  sessionMutationCommitGuard?: () => void,
) {
  const respond = vi.fn();
  const pending = Promise.resolve(
    talkClientHandlers["talk.client.toolCall"]!({
      req: { type: "req", id: "consult-authority", method: "talk.client.toolCall" },
      params,
      context,
      client,
      respond,
      sessionMutationAuthorization: authorization,
      sessionMutationCommitGuard,
    } as never),
  );
  return { respond, pending };
}

describe("voice consult registration authority", () => {
  const tempDirs = useAutoCleanupTempDirTracker((remove) =>
    afterEach(async () => {
      for (const authorization of authorizations.splice(0)) {
        authorization.release?.();
      }
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
    await captureRuntimeConfigAsyncReader()();
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
      const context = consultContext(config);
      const client = { connId: `${origin}-${wait}-delegation-source` };
      const sessionTarget = await prepareTalkSessionTarget(config, scope.sessionKey);
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
              sessionTarget,
            })
          : undefined;
      const relay = created ? relaySessions.get(created.relaySessionId)! : undefined;
      const selectedVoiceSessionId = relay?.id ?? voiceSessionId;
      const waiting = createDeferred();
      const resume = createDeferred();
      let pending: Promise<unknown> | undefined;
      const registration = registerConsult(sessionTarget, client.connId);
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
        const authorized = await authorizeConsult(params, context, client as never);
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
        const call = toolCall(params, context, authorized.authorization, client as never);
        const { respond } = call;
        pending = call.pending;
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
        registration.cleanup();
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
      const sessionTarget = await prepareTalkSessionTarget({}, scope.sessionKey);
      const created = createTalkRealtimeRelaySession({
        context,
        connId: client.connId,
        cfg: {},
        provider: createIdleRelayProvider(),
        providerConfig: {},
        instructions: "brief",
        tools: [],
        controlSource: "transcript",
        sessionTarget,
      });
      const relay = relaySessions.get(created.relaySessionId)!;
      const runId = "queued-consult";
      const registration = registerConsult(sessionTarget, client.connId);
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
      const authorized = await authorizeConsult(params, context, client as never);
      const { respond, pending } = toolCall(
        params,
        context,
        authorized.authorization,
        client as never,
      );
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
      const context = consultContext();
      const params = consultParams("cold-consult-call");
      const authorized = await authorizeConsult(params, context);
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
      const { respond, pending } = toolCall(
        params,
        context,
        authorized.authorization,
        null,
        sdk
          ? () => {
              expect(inWorkerGrant).toBe(false);
              checkedWhileCold ||= getOpenClawAgentDatabaseIfOpen(scope) === undefined;
            }
          : undefined,
      );
      await pending;
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
      const context = consultContext();
      const params = consultParams("queued-consult-call");
      const authorized = await authorizeConsult(params, context);
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
      const { respond, pending: running } = toolCall(
        params,
        context,
        authorized.authorization,
        null,
        revoked === "sdk" || revoked === "current"
          ? () => {
              expect(inWorkerGrant).toBe(false);
              expect(loadSessionEntry(scope)?.sessionId).toBe("original-consult-session");
              nativeSdkCommitObserved ||=
                getOpenClawAgentDatabaseIfOpen(scope)?.db.isTransaction === true;
              if (!sdkCurrent) {
                throw new Error("SDK consult authority was revoked");
              }
            }
          : undefined,
      );
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

  it.each(["memory-source", "foreign", "incognito"] as const)(
    "checks %s authority at durable voice admission without caller-thread storage work",
    async (kind) => {
      const memorySource = kind === "memory-source";
      const sourceKey =
        kind !== "foreign" ? "agent:main:dashboard:incognito-native" : scope.sessionKey;
      if (kind !== "foreign") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: sourceKey },
          { sessionId: "cold-native-source", updatedAt: 1, incognito: true },
        );
      }
      const authorized = await authorizeConsult(
        { sessionKey: sourceKey },
        { getRuntimeConfig: () => ({}) } as GatewayRequestHandlerOptions["context"],
        null,
        "talk.client.create",
      );
      const target = memorySource
        ? { agentId: "main", sessionKey: sourceKey }
        : { agentId: `cold-native-${kind}`, sessionKey: `agent:cold-native-${kind}:main` };
      const targetPath = resolveOpenClawAgentSqlitePath(target);
      const targetPaths = new Set([
        targetPath,
        readDatabasePathIdentitySync(targetPath).canonicalPath,
      ]);
      if (!memorySource) {
        expect(existsSync(targetPath)).toBe(false);
      }
      let nativeAuthorityObserved = false;
      let workerAuthorityObserved = false;
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
        const assertCurrent = composeSessionSourceAssertion(
          [authorized.authorization!.assertCurrent],
          (assertSource) => {
            assertSource();
            workerAuthorityObserved ||= inWorkerGrant;
            nativeAuthorityObserved ||=
              getOpenClawAgentDatabaseIfOpen(target)?.db.isTransaction === true;
          },
          memorySource ? undefined : { preparedCheck: (assertSource) => assertSource() },
        );
        await voiceSessions.createOrResumeClientVoiceSession({
          ...target,
          voiceSessionId: "cold-native-voice",
          origin: "client",
          ...(memorySource
            ? {
                source: {
                  storePath: authorized.authorization!.talkSessionTarget!.storePath,
                  assertCurrent,
                },
              }
            : { requester: assertCurrent }),
        });
        if (memorySource) {
          expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
        } else {
          expect(schemaSql).toEqual([]);
        }
        expect(workerAuthorityObserved).toBe(true);
        expect(nativeAuthorityObserved).toBe(false);
        expect(
          clientVoiceSessionTesting.readRecord(target.agentId, "cold-native-voice"),
        ).toMatchObject({
          sessionKey: target.sessionKey,
          status: "open",
        });
      } finally {
        sql.restore();
      }
    },
  );
});
