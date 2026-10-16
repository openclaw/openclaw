import { existsSync } from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
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
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
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
import { observeTargetSql } from "./client-create-ensure.test-support.js";
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
type Context = GatewayRequestHandlerOptions["context"];
type Params = GatewayRequestHandlerOptions["params"];

function consultContext(
  config: ReturnType<Context["getRuntimeConfig"]> = {
    agents: { defaults: { workspace: path.join(tempDir, "workspace") } },
  },
) {
  return Object.assign(createGatewayRequestContext(makeContextParams()), {
    getRuntimeConfig: () => config,
    getCommittedRuntimeConfig: () => config,
  });
}

async function authorizeConsult(
  params: Params,
  context: Context,
  client: GatewayRequestHandlerOptions["client"] = null,
  method = "talk.client.toolCall",
) {
  const authorized = await resolveSessionMutationAuthorizationAsync({
    method,
    requestParams: params,
    context,
    client,
  });
  expect(authorized.error).toBeNull();
  authorizations.push(authorized.authorization!);
  return authorized.authorization!;
}

function invokeConsult(
  params: Params,
  context: Context,
  authorization: SessionMutationAuthorization | undefined,
  options: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn();
  const request = {
    req: { type: "req", id: "consult-authority", method: "talk.client.toolCall" },
    params,
    context,
    client: null,
    respond,
    sessionMutationAuthorization: authorization,
    ...options,
  };
  return {
    respond,
    pending: Promise.resolve(talkClientHandlers["talk.client.toolCall"]!(request as never)),
  };
}

async function createRelay(context: Context, connId: string) {
  const cfg = context.getRuntimeConfig();
  const created = createTalkRealtimeRelaySession({
    context,
    connId,
    cfg,
    provider: createIdleRelayProvider(),
    providerConfig: {},
    instructions: "brief",
    tools: [],
    controlSource: "transcript",
    sessionTarget: await prepareTalkSessionTarget(cfg, scope.sessionKey),
  });
  return relaySessions.get(created.relaySessionId)!;
}

function registerAbort(context: Context) {
  return registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: "queued-consult",
    sessionId: "original-consult-session",
    sessionKey: scope.sessionKey,
    timeoutMs: 60_000,
  });
}

function observeAuthority(
  authorization: SessionMutationAuthorization,
  target: { agentId: string } = scope,
  prepared = false,
) {
  const observed = { native: false, worker: false };
  return {
    observed,
    assert: composeSessionSourceAssertion(
      [authorization.assertCurrent],
      (assertSource) => {
        assertSource();
        observed.worker ||= inWorkerGrant;
        observed.native ||= getOpenClawAgentDatabaseIfOpen(target)?.db.isTransaction === true;
      },
      prepared ? { preparedCheck: (assertSource) => assertSource() } : undefined,
    ),
  };
}

function consultParams(
  callId: string,
  identity: { voiceSessionId?: string; relaySessionId?: string } = { voiceSessionId },
) {
  return {
    sessionKey: scope.sessionKey,
    ...identity,
    callId,
    name: "openclaw_agent_consult",
    args: { question: "Report the fixture status" },
  };
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
      const relay = origin === "relay" ? await createRelay(context, client.connId) : undefined;
      const selectedVoiceSessionId = relay?.id ?? voiceSessionId;
      const waiting = createDeferred();
      const resume = createDeferred();
      let pending: Promise<unknown> | undefined;
      const registration = registerAbort(context);
      try {
        setTestEnvValue("OPENCLAW_STATE_DIR", successor);
        await voiceSessions.createOrResumeClientVoiceSession({
          ...scope,
          voiceSessionId: selectedVoiceSessionId,
          origin,
        });
        env.restore();
        const params = consultParams("delegated-source-call", {
          ...(relay ? { relaySessionId: relay.id } : {}),
          ...(wait === "chat" ? { voiceSessionId: selectedVoiceSessionId } : {}),
        });
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
        const call = invokeConsult(params, context, authorized, {
          client: client as never,
        });
        const { respond } = call;
        pending = call.pending;
        await withinTest(
          awaitGateBeforeSettlement(
            waiting.promise,
            pending,
            "Tool call ended before source handoff waited",
          ),
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
      const relay = await createRelay(context, client.connId);
      const runId = "queued-consult";
      const registration = registerAbort(context);
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
      const params = consultParams("replacement-registration-call", {
        relaySessionId: relay.id,
        voiceSessionId: relay.id,
      });
      const authorized = await authorizeConsult(params, context, client as never);
      const { respond, pending } = invokeConsult(params, context, authorized, {
        client: client as never,
      });
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
        expect(voiceSessions.resolveClientVoiceRunBinding(runId) !== undefined).toBe(
          Boolean(current),
        );
        expect(registration.controller.signal.aborted).toBe(!current);
        if (current) {
          expect(current.isCurrent()).toBe(true);
          current.release();
        } else {
          expect(relay).toMatchObject({
            activeAgentRuns: { size: 0 },
            activeAgentToolCalls: { size: 0 },
          });
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
      const coldSchemaSql = observeTargetSql(
        targetPath,
        /\b(?:sqlite_master|sqlite_schema|(?:pragma_)?(?:table_(?:xinfo|info)|index_(?:list|xinfo|info)|foreign_key_(?:list|check)|quick_check|integrity_check)|create\s+(?:(?:unique|virtual)\s+)?(?:table|index|trigger|view)|alter\s+table|drop\s+(?:table|index|trigger|view))\b/i,
        () => !getOpenClawAgentDatabaseIfOpen(scope),
      );
      let checkedWhileCold = false;
      const { respond, pending } = invokeConsult(params, context, authorized, {
        sessionMutationCommitGuard: sdk
          ? () => {
              expect(inWorkerGrant).toBe(false);
              checkedWhileCold ||= getOpenClawAgentDatabaseIfOpen(scope) === undefined;
            }
          : undefined,
      });
      await pending;
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
      expect(chat.dispatched).toHaveBeenCalledOnce();
      expect(coldSchemaSql.queries).toEqual([]);
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
      const { respond, pending: running } = invokeConsult(params, context, authorized, {
        sessionMutationCommitGuard:
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
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            queued.promise,
            running,
            "Consult ended before real registration was queued",
          ),
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
        const current = revoked === "current" || revoked === "worker-current";
        expect(record?.consultRunIds).toEqual(current ? ["queued-consult"] : []);
        expect(voiceSessions.resolveClientVoiceRunBinding("queued-consult") !== undefined).toBe(
          current,
        );
        expect(chat.dispatched).toHaveBeenCalledTimes(current ? 1 : 0);
        expect(respond.mock.lastCall?.[0]).toBe(current);
        if (current) {
          expect(nativeSdkCommitObserved).toBe(revoked === "current");
        }
      } finally {
        releaseQueue.resolve();
        await running;
        await blocker;
      }
    },
  );

  it.each(["memory-source", "foreign", "incognito"] as const)(
    "checks %s authority at durable admission without caller-thread SQL",
    async (kind) => {
      const memorySource = kind === "memory-source";
      const sourceKey =
        kind === "foreign" ? scope.sessionKey : `agent:main:dashboard:incognito-${kind}`;
      if (kind !== "foreign") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: sourceKey },
          { sessionId: "cold-native-source", updatedAt: 1, incognito: true },
        );
      }
      const authorized = await authorizeConsult(
        { sessionKey: sourceKey },
        { getRuntimeConfig: () => ({}) } as Context,
        null,
        "talk.client.create",
      );
      const target = memorySource
        ? { agentId: "main", sessionKey: sourceKey }
        : {
            agentId: `cold-native-${kind}`,
            sessionKey: `agent:cold-native-${kind}:main`,
          };
      const targetPath = resolveOpenClawAgentSqlitePath(target);
      if (!memorySource) {
        expect(existsSync(targetPath)).toBe(false);
      }
      const source = authorized.talkSessionTarget;
      if (!source) {
        throw new Error("Expected a prepared Talk source");
      }
      const authority = observeAuthority(authorized, target, !memorySource);
      sqlReads?.restore();
      sqlReads = undefined;
      const sql = observeTargetSql(
        targetPath,
        /\b(?:create\s+(?:(?:unique|virtual)\s+)?(?:table|index|trigger|view)|alter\s+table|drop\s+(?:table|index|trigger|view)|quick_check|integrity_check)\b/i,
      );
      try {
        await voiceSessions.createOrResumeClientVoiceSession({
          ...target,
          voiceSessionId: "cold-native-voice",
          origin: "client",
          ...(memorySource
            ? { source: { storePath: source.storePath, assertCurrent: authority.assert } }
            : { requester: authority.assert }),
        });
        expect(memorySource ? sql.allQueries.filter(isSessionEntryDataSql) : sql.queries).toEqual(
          [],
        );
        expect(authority.observed).toEqual({ worker: true, native: false });
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
