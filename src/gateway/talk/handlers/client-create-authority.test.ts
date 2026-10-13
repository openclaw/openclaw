import { copyFileSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { closeAuthProfileReadPool } from "../../../agents/auth-profiles/sqlite-read-pool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import * as sessionSourcePredicates from "../../../config/sessions/session-source-predicate.worker.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target-paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as sqliteSnapshotSource from "../../../infra/sqlite-snapshot-source.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import {
  findOpenClawAgentDatabaseIdentity,
  readOpenClawAgentDatabaseIdentity,
} from "../../../state/openclaw-agent-db-identity.js";
import {
  closeCachedOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "../../../state/openclaw-agent-db-lifecycle.js";
import * as readonlyOpen from "../../../state/openclaw-agent-db-readonly-open.js";
import { closeIdleOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly-scope.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { prepareClientVoiceSessionClose } from "../../../talk/client-voice-session-lifecycle.js";
import { readVoiceSessionRecordInTransaction } from "../../../talk/client-voice-session-store.js";
import * as voiceWriters from "../../../talk/client-voice-session-write.js";
import * as voiceKernel from "../../../talk/client-voice-session-write.kernel.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import {
  drainSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../../test-utils/session-state-cleanup.js";
import { useUserProfileCatalogForTest } from "../../../test-utils/user-profile-catalog.js";
import { captureGatewayDeviceRevocation } from "../../device-revocation.js";
import { prepareGatewayRecipientProfile } from "../../expected-profile.js";
import { makeClient } from "../../server-broadcast.test-helpers.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
} from "../../server-methods/session-mutation-guards.js";
import type {
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "../../server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "../../server-shared-auth-generation.js";
import { SessionMutationAuthorizationChangedError } from "../../session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "../../session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { cleanupTalkConnection, prepareTalkConnectionClose } from "../session-registry.js";
import {
  completeTalkVoiceChange,
  readTalkVoiceSelection,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "../voice-selection.js";
import { registerClientCreateEnsureTests } from "./client-create-ensure.test-support.js";
import { registerClientCreateSourceAuthorityTests } from "./client-create-source-authority.test-support.js";
import { createTalkClient } from "./client-create.js";
import {
  browserSession,
  observeTalkVoiceChangeRequest,
  createDelegatedBrowserProviderFixture,
  type BrowserRequest,
} from "./client-fixtures.test-support.js";
import { talkClientHandlers } from "./client.js";
import { talkVoiceHandlers } from "./voice.js";

const voiceMocks = vi.hoisted(() => ({ resolveConfiguredRealtimeVoiceProviderAsync: vi.fn() }));
vi.mock("../../../talk/provider-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-resolver.js")>()),
  resolveConfiguredRealtimeVoiceProviderAsync:
    voiceMocks.resolveConfiguredRealtimeVoiceProviderAsync,
}));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const sessionKey = "agent:main:main";
const sessionId = "voice-transcript-session";
let tempDir: string;
let ownedVoiceSessionId: string | undefined;
let ownedVoiceSessionKey = sessionKey;
let forbiddenSnapshotStacks: string[] = [];
const authorizations: SessionMutationAuthorization[] = [];
let observeAdmission:
  | ((request: operationAdmission.SqliteWorkerAdmissionRequest, run: () => void) => void)
  | undefined;
function configureDelegatedBrowserProvider(
  createBrowserSession: (request: BrowserRequest) => Promise<typeof browserSession>,
) {
  const fixture = createDelegatedBrowserProviderFixture(createBrowserSession, tempDir);
  setRuntimeConfigSnapshot(fixture.context.getRuntimeConfig());
  voiceMocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
    provider: fixture.provider,
    providerConfig: {},
    capabilities: fixture.provider.capabilities,
  });
  return fixture;
}
async function invokeCreate(options: GatewayRequestHandlerOptions) {
  setRuntimeConfigSnapshot(options.context.getRuntimeConfig());
  using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
  const admission = await resolveSessionMutationAuthorizationAsync({
    method: "talk.client.create",
    requestParams: options.params,
    context: options.context,
    client: options.client,
  });
  if (admission.error) {
    options.respond(false, undefined, admission.error);
    return;
  }
  try {
    await createTalkClient({ ...options, sessionMutationAuthorization: admission.authorization });
  } finally {
    admission.authorization?.release?.();
  }
}

describe("voice creation authority", () => {
  const prepareProfiles = useUserProfileCatalogForTest();
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-voice-authority-");
  afterEach(async () => {
    for (const authorization of authorizations.splice(0)) {
      authorization.release?.();
    }
    if (ownedVoiceSessionId) {
      await closeTalkClientGatewayControlSession({
        voiceSessionId: ownedVoiceSessionId,
        sessionKey: ownedVoiceSessionKey,
        connId: "conn-close",
      });
    }
    cleanupTalkConnection("conn-close", { warn: vi.fn() });
    clientVoiceSessionTesting.reset();
    try {
      await drainSessionStateForTest({ stateDir: tempDir });
      closeAuthProfileReadPool({ kind: "root", rootPath: tempDir });
      await closeOpenClawAgentDatabasesAsync(tempDir);
      clearRuntimeConfigSnapshot();
    } finally {
      envSnapshot.restore();
      vi.restoreAllMocks();
    }
    expect(forbiddenSnapshotStacks).toEqual([]);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    forbiddenSnapshotStacks = [];
    observeAdmission = undefined;
    let inWorkerGrant = false;
    const admitOperation = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        admitOperation((request, grant) => {
          const run = () => {
            const previous = inWorkerGrant;
            inWorkerGrant = true;
            try {
              admit(request, grant);
            } finally {
              inWorkerGrant = previous;
            }
          };
          if (observeAdmission) {
            observeAdmission(request, run);
          } else {
            run();
          }
        }, attachment),
    );
    const snapshot = sqliteSnapshotSource.prepareSqliteReadOnlyLocationSync;
    vi.spyOn(sqliteSnapshotSource, "prepareSqliteReadOnlyLocationSync").mockImplementation(
      (...args) => {
        if (inWorkerGrant) {
          const error = new Error("Synchronous SQLite snapshot requested inside a worker grant");
          forbiddenSnapshotStacks.push(error.stack ?? error.message);
          throw error;
        }
        return snapshot(...args);
      },
    );
    ownedVoiceSessionId = undefined;
    ownedVoiceSessionKey = sessionKey;
    tempDir = tempDirs.make();
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    await prepareProfiles();
    setRuntimeConfigSnapshot({});
    const seedEntry = { sessionId, updatedAt: Date.now() };
    await applySessionEntryOperation(
      { agentId: "main", sessionKey },
      { kind: "fields", patch: seedEntry },
      { fallbackEntry: seedEntry, replaceEntry: true, skipMaintenance: true },
    );
  });
  it("releases transport authority after a same-session replacement closes", async () => {
    const fixture = configureDelegatedBrowserProvider(async () => browserSession);
    const releaseSubscription = vi.fn();
    const lifetime = captureGatewayDeviceRevocation(fixture.context, {}, () => true, undefined, {
      isCurrent: () => true,
      subscribe: () => releaseSubscription,
    });
    const create = async (voiceSessionId?: string) => {
      const respond = vi.fn();
      await invokeCreate({
        req: { type: "req", id: "replace-voice", method: "talk.client.create" },
        params: { sessionKey, provider: "openai", ...(voiceSessionId ? { voiceSessionId } : {}) },
        isWebchatConnect: () => false,
        respond,
        context: fixture.context as never,
        client: fixture.client as never,
        hasCurrentClientAuthority: lifetime.isCurrent,
      });
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
      ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
      return ownedVoiceSessionId;
    };
    try {
      const originalId = await create();
      expect(originalId).toBeTruthy();
      expect(await create(originalId)).toBe(originalId);
      expect(releaseSubscription).not.toHaveBeenCalled();
      await closeTalkClientGatewayControlSession({
        voiceSessionId: originalId!,
        sessionKey,
        connId: fixture.client.connId,
      });
      lifetime.release();
      expect(releaseSubscription).toHaveBeenCalledOnce();
    } finally {
      lifetime.release();
    }
  });

  it.each([
    { mixed: false, grant: false, revoked: undefined },
    { mixed: false, grant: false, revoked: "foreign" },
    { mixed: true, grant: false, revoked: undefined },
    { mixed: true, grant: false, revoked: "foreign" },
    { mixed: true, grant: false, revoked: "local" },
    { mixed: false, grant: true, revoked: undefined },
    { mixed: false, grant: true, revoked: "local" },
  ])(
    "validates cross-store voice authority atomically (mixed=$mixed, grant=$grant, revoked=$revoked)",
    async ({ mixed, grant, revoked }) => {
      const local = { agentId: "main", sessionKey };
      const foreign = { agentId: "source", sessionKey: "agent:source:main" };
      const foreignEntry = { sessionId: "foreign-source", updatedAt: 1 };
      // The injected foreign commit must not compete with automatic fixture reclamation.
      await applySessionEntryOperation(
        foreign,
        { kind: "fields", patch: foreignEntry },
        { fallbackEntry: foreignEntry, replaceEntry: true, skipMaintenance: true },
      );
      const config: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {}, source: {} } },
      };
      setRuntimeConfigSnapshot(config);
      const client = roleClient("write", "cross-store-voice");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      prepareGatewayRecipientProfile(client);
      const prepare = async (scope: typeof local, method = "sessions.patch") => {
        const result = await resolveSessionMutationAuthorizationAsync({
          method,
          requestParams:
            method === "talk.client.create"
              ? { sessionKey: scope.sessionKey }
              : { key: scope.sessionKey, agentId: scope.agentId },
          context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
          client,
        });
        expect(result.error).toBeNull();
        authorizations.push(result.authorization!);
        return result.authorization!;
      };
      openOpenClawAgentDatabase(local);
      const localReader = retainOpenClawAgentDatabaseReadOnly(local);
      if (!localReader.found) {
        throw new Error("Expected the authorization owner's native reader");
      }
      const localReads = trackSqliteStatementExecutions(localReader.database.db, ["data"], (sql) =>
        isSessionEntryDataSql(sql) || /\bcache_entries\b/i.test(sql) ? "data" : null,
      );
      const foreignAuthority = (await prepare(foreign)).assertCurrent;
      const localAuthority = mixed ? (await prepare(local)).assertCurrent : undefined;
      const transactionAuthority = grant ? await prepare(local, "talk.client.create") : undefined;
      expect(localReads.counts.data).toBe(0);
      let grantLocalReads = 0;
      let revokedSource = false;
      let inGrant = false;
      const voiceSessionId = "cross-store-voice";
      const foreignDatabase = openOpenClawAgentDatabase(foreign);
      const foreignIdentity = readOpenClawAgentDatabaseIdentity(foreignDatabase);
      let checkedBeforeWrite = false;
      let checkedAfterWrite = false;
      let sdkSawCommittedVoice = false;
      let sdkMutation: Promise<void> | undefined;
      const observeSourceRead = () => {
        if (localReader.database.db.isTransaction) {
          const written = readVoiceSessionRecordInTransaction(localReader.database, voiceSessionId);
          checkedBeforeWrite ||= !written;
          checkedAfterWrite ||= Boolean(written);
          if (!revoked && !sdkMutation) {
            sdkMutation = Promise.resolve().then(() => {
              sdkSawCommittedVoice =
                !localReader.database.db.isTransaction &&
                readVoiceSessionRecordInTransaction(localReader.database, voiceSessionId)
                  ?.status === "open";
              replaceSessionEntrySync(foreign, { sessionId: "sdk-successor", updatedAt: 2 });
            });
            void sdkMutation.catch(() => {});
          }
        }
      };
      const validateSource = sessionSourcePredicates.readSessionSourceValidation;
      const foreignReads = vi
        .spyOn(sessionSourcePredicates, "readSessionSourceValidation")
        .mockImplementation((database, ...args) => {
          if (
            database.db === localReader.database.db ||
            findOpenClawAgentDatabaseIdentity(database)?.identity === foreignIdentity.identity
          ) {
            observeSourceRead();
          }
          return validateSource(database, ...args);
        });
      const mutateVoice = voiceKernel.mutateVoiceSessionInDatabase;
      const mutationSpy = vi
        .spyOn(voiceKernel, "mutateVoiceSessionInDatabase")
        .mockImplementation((database, mutation) => {
          const result = mutateVoice(database, mutation);
          if (revoked && mutation.voiceSessionId === voiceSessionId && !revokedSource) {
            // Revoke before final validation without depending on source-check order.
            revokedSource = true;
            const source = revoked === "local" ? database : foreignDatabase;
            source.db
              .prepare(
                "UPDATE session_nodes SET current_session_id = 'revoked-source', entry_json = json_set(entry_json, '$.sessionId', 'revoked-source') WHERE session_key = ?",
              )
              .run(revoked === "local" ? local.sessionKey : foreign.sessionKey);
          }
          return result;
        });
      const open = readonlyOpen.openOpenClawAgentDatabaseReadOnly;
      const openSpy = vi
        .spyOn(readonlyOpen, "openOpenClawAgentDatabaseReadOnly")
        .mockImplementation((...args) => {
          if (inGrant) {
            throw new Error("Cold source admission ran inside the voice worker grant");
          }
          return open(...args);
        });
      observeAdmission = (_request, run) => {
        const start = localReads.counts.data;
        inGrant = true;
        try {
          run();
        } finally {
          inGrant = false;
          grantLocalReads += localReads.counts.data - start;
        }
      };
      try {
        const creating = voiceSessions.createOrResumeClientVoiceSession({
          ...local,
          voiceSessionId,
          origin: "client",
          ...(transactionAuthority
            ? {
                requester: foreignAuthority,
                source: {
                  storePath: resolveOpenClawAgentSqlitePath(local),
                  assertCurrent: transactionAuthority.assertCurrent,
                  prepareWorkerGrant: transactionAuthority.prepareWorkerGrant,
                },
              }
            : mixed
              ? {
                  source: {
                    storePath: resolveOpenClawAgentSqlitePath(foreign),
                    assertCurrent: composeSessionSourceAssertion([
                      localAuthority,
                      foreignAuthority,
                    ]),
                  },
                }
              : { requester: foreignAuthority }),
        });
        if (revoked) {
          await expect(creating).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
          await expect(creating).rejects.toThrow(
            `session changed before ${grant ? "talk.client.create" : "sessions.patch"}; retry the request`,
          );
          expect(revokedSource).toBe(true);
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toBeUndefined();
        } else {
          await expect(creating).resolves.toBe(voiceSessionId);
          await sdkMutation;
          expect(sdkSawCommittedVoice).toBe(true);
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
        }
        expect(checkedBeforeWrite).toBe(true);
        expect(checkedAfterWrite).toBe(true);
        expect(grantLocalReads).toBe(0);
      } finally {
        observeAdmission = undefined;
        await sdkMutation;
        foreignReads.mockRestore();
        mutationSpy.mockRestore();
        openSpy.mockRestore();
        localReads.restore();
        localReader.claim.release();
      }
    },
  );
  it("replaces a voice on the same chat only after both the browser and provider are ready", async () => {
    const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
      ...browserSession,
      model: request.model,
      voice: request.voice ?? "cove",
    }));
    const fixture = configureDelegatedBrowserProvider(createBrowserSession);
    Object.assign(fixture.provider, { voices: ["cove", "ember"] });
    const respond = vi.fn();
    const create = (params: Record<string, unknown>) =>
      invokeCreate({
        params: { sessionKey, capabilities: ["voice-selection"], ...params },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
    await create({ provider: "openai", model: "gpt-live-1-codex" });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ model: "gpt-live-1-codex", voice: "cove" }),
      undefined,
    );
    const originalId = respond.mock.calls.at(-1)?.[1].voiceSessionId as string;
    ownedVoiceSessionId = originalId;
    createBrowserSession.mock.calls[0]?.[0].gatewayControl?.onReady?.();
    const original = resolveTalkVoiceSession({
      kind: "client",
      connId: fixture.client.connId,
      voiceSessionId: originalId,
    });
    expect(readTalkVoiceSelection(original)).toMatchObject({
      sessionKey,
      voice: "cove",
      voices: ["cove", "ember"],
      canChange: true,
    });
    const send = vi.fn();
    const changing = requestTalkVoiceChange({
      session: original,
      voice: "ember",
      requesterConnId: fixture.client.connId,
      assertCurrent: () => {},
      send,
    });
    void changing.catch(() => {});
    const changeId = send.mock.calls[0]?.[0].changeId as string;
    await create({ voiceChangeId: changeId, voiceSessionId: originalId });
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "A voice replacement requires a fresh voice session id" }),
    );
    expect(createBrowserSession).toHaveBeenCalledOnce();
    const closeRespond = vi.fn();
    await talkClientHandlers["talk.client.close"]?.({
      params: { sessionKey, voiceSessionId: originalId },
      respond: closeRespond,
      context: { getRuntimeConfig: () => ({}) },
      client: { connId: "conn-close" },
    } as never);
    expect(closeRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    await create({ voiceChangeId: changeId, model: "gpt-realtime-2.1", voice: "cove" });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ model: "gpt-live-1-codex", voice: "ember" }),
      undefined,
    );
    const replacementId = respond.mock.calls.at(-1)?.[1].voiceSessionId as string;
    ownedVoiceSessionId = replacementId;
    expect(replacementId).not.toBe(originalId);
    const replacementRequest = createBrowserSession.mock.calls[1]?.[0];
    expect(replacementRequest).toMatchObject({ model: "gpt-live-1-codex", voice: "ember" });
    let applied = false;
    void changing.then(
      () => {
        applied = true;
      },
      () => {},
    );
    const completed = completeTalkVoiceChange({
      changeId,
      connId: fixture.client.connId,
      voiceSessionId: replacementId,
      outcome: "ready",
    });
    void completed.catch(() => {});
    await Promise.resolve();
    expect(applied).toBe(false);
    replacementRequest?.gatewayControl?.onReady?.();
    await completed;
    await expect(changing).resolves.toMatchObject({
      status: "applied",
      voiceSessionId: replacementId,
      sessionKey,
      voice: "ember",
    });
    expect(clientVoiceSessionTesting.readRecord("main", originalId)?.status).toBe("closed");
    expect(clientVoiceSessionTesting.readRecord("main", replacementId)?.status).toBe("open");
  });

  it.each(
    ["same-store", "custom-store", "incognito"].flatMap((kind) =>
      [false, true].map((revoked) => ({ kind, revoked })),
    ),
  )(
    "creates a $kind replacement without cold reads in write grants (revoked=$revoked)",
    async ({ kind, revoked }) => {
      const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
        ...browserSession,
        voice: request.voice ?? "cove",
      }));
      const fixture = configureDelegatedBrowserProvider(createBrowserSession);
      Object.assign(fixture.provider, { voices: ["cove", "ember"] });
      const config = {
        ...fixture.context.getRuntimeConfig(),
        ...(kind === "custom-store"
          ? { session: { store: path.join(tempDir, "custom.sqlite") } }
          : {}),
      };
      fixture.context.getRuntimeConfig = () => config;
      setRuntimeConfigSnapshot(config);
      const key = kind === "incognito" ? "agent:main:dashboard:incognito-voice-source" : sessionKey;
      ownedVoiceSessionKey = key;
      const scope = { agentId: "main", sessionKey: key, storePath: config.session?.store };
      const seedEntry = {
        sessionId,
        updatedAt: Date.now(),
        ...(kind === "incognito" ? { incognito: true as const } : {}),
      };
      await applySessionEntryOperation(
        scope,
        { kind: "fields", patch: seedEntry },
        { fallbackEntry: seedEntry, replaceEntry: true, skipMaintenance: true },
      );
      const respond = vi.fn();
      const create = (voiceChangeId?: string) =>
        invokeCreate({
          params: { sessionKey: key, capabilities: ["voice-selection"], voiceChangeId },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
      await create();
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
      ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
      createBrowserSession.mock.calls[0]?.[0].gatewayControl?.onReady?.();
      const original = resolveTalkVoiceSession({
        kind: "client",
        connId: fixture.client.connId,
        voiceSessionId: ownedVoiceSessionId,
      });
      const sourcePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(
        original.sessionTarget.storePath,
      ).path;
      const changed = vi.fn();
      const waitForVoiceChange = observeTalkVoiceChangeRequest(fixture.context.broadcastToConnIds);
      const change = Promise.resolve(
        talkVoiceHandlers["talk.voice.set"]!({
          req: { type: "req", id: "change", method: "talk.voice.set", params: {} },
          params: { voiceSessionId: ownedVoiceSessionId, voice: "ember" },
          respond: changed,
          context: fixture.context,
          client: fixture.client,
          isWebchatConnect: () => false,
        } as never),
      );
      await waitForVoiceChange(change);
      const changeId = fixture.context.broadcastToConnIds.mock.calls.find(
        ([event]) => event === "talk.voice.change",
      )?.[1]?.changeId;
      expect(changeId).toBeTypeOf("string");
      let creatingVoice = false;
      let admittedReplacementId: string | undefined;
      let resetSource = false;
      let inGrant = false;
      let coldOpenAttempts = 0;
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const grantQueries: string[] = [];
      observeAdmission = (request, run) => {
        if (creatingVoice) {
          if (revoked && !resetSource && request.stage === "prepare") {
            replaceSessionEntrySync(scope, {
              sessionId: "reset-voice-source",
              updatedAt: Date.now(),
              ...(kind === "incognito" ? { incognito: true } : {}),
            });
            resetSource = true;
          }
          closeIdleOpenClawAgentDatabaseReadOnly(sourcePath);
        }
        const start = reads.queries.length;
        inGrant = creatingVoice;
        try {
          run();
        } finally {
          inGrant = false;
          if (creatingVoice) {
            grantQueries.push(...reads.queries.slice(start));
          }
        }
      };
      const open = readonlyOpen.openOpenClawAgentDatabaseReadOnly;
      const openSpy = vi
        .spyOn(readonlyOpen, "openOpenClawAgentDatabaseReadOnly")
        .mockImplementation((...args) => {
          if (inGrant) {
            coldOpenAttempts += 1;
            throw new Error("Cold source admission ran inside the voice worker grant");
          }
          return open(...args);
        });
      const createVoice = voiceSessions.createOrResumeClientVoiceSession;
      const createSpy = vi
        .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
        .mockImplementation(async (params) => {
          if (kind === "incognito" && revoked) {
            await replaceSessionEntry(scope, {
              sessionId: "reset-voice-source",
              updatedAt: Date.now(),
              incognito: true,
            });
            resetSource = true;
          }
          if (kind !== "incognito") {
            const database = getOpenClawAgentDatabaseIfOpen({
              agentId: "main",
              path: sourcePath,
            });
            if (database) {
              closeCachedOpenClawAgentDatabase(database);
            }
          }
          creatingVoice = true;
          try {
            return (admittedReplacementId = await createVoice({
              ...params,
              assertCurrent: () => {
                params.assertCurrent?.();
                if (kind === "custom-store" && revoked && !resetSource) {
                  replaceSessionEntrySync(scope, {
                    sessionId: "reset-voice-source",
                    updatedAt: Date.now(),
                  });
                  resetSource = true;
                }
              },
            }));
          } finally {
            creatingVoice = false;
          }
        });
      try {
        await create(changeId);
        expect(coldOpenAttempts).toBe(0);
        if (revoked) {
          expect(resetSource).toBe(true);
          expect(admittedReplacementId).toBeUndefined();
          expect(respond.mock.lastCall?.[0]).toBe(false);
          expect(respond.mock.lastCall?.[2]?.message).not.toContain("Cold source admission");
        } else {
          expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
          ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
          expect(clientVoiceSessionTesting.readRecord("main", ownedVoiceSessionId!)?.status).toBe(
            "open",
          );
        }
        if (kind === "same-store") {
          expect(grantQueries.filter(isSessionEntryDataSql)).toEqual([]);
        }
      } finally {
        createSpy.mockRestore();
        openSpy.mockRestore();
        observeAdmission = undefined;
        reads.restore();
        cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
        await change;
      }
    },
  );

  it.each(["callback-absent", "worker"] as const)(
    "creates voice on an admitted chat without a caller-thread write transaction (%s)",
    async (authority) => {
      const fixture = configureDelegatedBrowserProvider(async () => browserSession);
      ownedVoiceSessionKey = "main";
      const source = openOpenClawAgentDatabase({ agentId: "main" });
      const respond = vi.fn();
      const transactions: string[] = [];
      const statements = observeHostDataSql((sql, database) => {
        if (database === source.db && /^\s*begin\s+immediate\b/i.test(sql)) {
          transactions.push(sql);
        }
      });
      let releaseAuthority: (() => void) | undefined;
      try {
        const { client } = makeClient(fixture.client.connId, "operator", ["operator.admin"]);
        const options: GatewayRequestHandlerOptions = {
          req: { type: "req", id: "worker-voice", method: "talk.client.create" },
          params: { sessionKey: "main", provider: "openai" },
          isWebchatConnect: () => false,
          respond,
          context: createDirectChatContext({
            getRuntimeConfig: fixture.context.getRuntimeConfig,
            getClientConnIds: (filter) => new Set(!filter || filter(client) ? [client.connId] : []),
            chatAbortControllers: fixture.context.chatAbortControllers,
            broadcastToConnIds: fixture.context.broadcastToConnIds,
          }),
          client,
        };
        if (authority === "worker") {
          const lifetime = captureGatewayDeviceRevocation(fixture.context, {}, () => true);
          releaseAuthority = lifetime.release;
          options.hasCurrentClientAuthority = lifetime.isCurrent;
          const generation = new SharedGatewaySessionGenerationState({
            current: undefined,
            required: undefined,
          });
          bindWebSocketRequestMutationAuthority(options, client, generation.reader);
          const admitted = await resolveSessionMutationAuthorizationAsync({
            method: options.req.method,
            requestParams: options.params,
            context: options.context,
            client,
          });
          expect(admitted.error).toBeNull();
          try {
            await createTalkClient(
              bindGatewayRequestHandlerMutationAuthority(
                options,
                { ...options, sessionMutationAuthorization: admitted.authorization },
                undefined,
              ),
            );
          } finally {
            admitted.authorization?.release?.();
          }
        } else {
          await invokeCreate(options);
        }
        expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
        ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
        expect(transactions).toEqual([]);
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sessionId);
        expect(clientVoiceSessionTesting.readRecord("main", ownedVoiceSessionId!)?.status).toBe(
          "open",
        );
      } finally {
        releaseAuthority?.();
        statements.restore();
      }
    },
  );

  registerClientCreateEnsureTests({
    tempDir: () => tempDir,
    ownVoice: (id, key) => {
      ownedVoiceSessionId = id;
      ownedVoiceSessionKey = key;
    },
    configureProvider: configureDelegatedBrowserProvider,
    invokeCreate,
    observeAdmission: (observer) => {
      observeAdmission = observer;
    },
  });

  it.each(["startup-copy", "active-copy", "healthy"] as const)(
    "keeps browser provider writes on their creator source (%s)",
    async (phase) => {
      const persistence = prepareClientVoiceSessionClose();
      let providerRequest: BrowserRequest | undefined;
      const fixture = configureDelegatedBrowserProvider(async (request) => {
        providerRequest = request;
        return browserSession;
      });
      const voiceSessionId = "browser-creator-source";
      const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const displacedPath = `${sourcePath}.creator`;
      let replacementBytes: Buffer | undefined;
      const replaceSource = async () => {
        await closeOpenClawAgentDatabasesAsync(tempDir);
        renameSync(sourcePath, displacedPath);
        copyFileSync(displacedPath, sourcePath);
        replacementBytes = readFileSync(sourcePath);
        using copied = new DatabaseSync(sourcePath, { readOnly: true });
        expect(readVoiceSessionRecordInTransaction({ db: copied }, voiceSessionId)?.status).toBe(
          "open",
        );
      };
      const createVoice = voiceSessions.createOrResumeClientVoiceSession;
      const intercepted = vi
        .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
        .mockImplementationOnce(async (...args) => {
          const id = await createVoice(...args);
          if (phase === "startup-copy") {
            await replaceSource();
          }
          return id;
        });
      const respond = vi.fn();
      try {
        await invokeCreate({
          params: { sessionKey, provider: "openai", voiceSessionId },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
        expect(respond.mock.lastCall?.[0]).toBe(phase !== "startup-copy");
        if (phase !== "startup-copy") {
          ownedVoiceSessionId = voiceSessionId;
          if (phase === "active-copy") {
            await replaceSource();
          }
          providerRequest?.gatewayControl?.onTranscript?.("user", "Final creator transcript", true);
          await closeTalkClientGatewayControlSession({
            voiceSessionId,
            sessionKey,
            connId: fixture.client.connId,
          }).catch((error: unknown) => {
            if (phase === "healthy") {
              throw error;
            }
          });
        }
        expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
        await persistence.drain();
        await closeOpenClawAgentDatabasesAsync(tempDir);
        if (replacementBytes) {
          expect(readFileSync(sourcePath)).toEqual(replacementBytes);
        } else {
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
            status: "closed",
            hasUserTranscript: true,
          });
        }
      } finally {
        try {
          await persistence.drain();
        } finally {
          intercepted.mockRestore();
        }
      }
    },
  );

  it("joins committed browser creation before the real Talk close decides logical state", async () => {
    const fixture = configureDelegatedBrowserProvider(async () => browserSession);
    const voiceSessionId = "browser-creation-close";
    const committed = createDeferred();
    const releaseCreation = createDeferred();
    const providerClosing = createDeferred();
    fixture.cancelBrowserSession.mockImplementation(async () => {
      providerClosing.resolve();
    });
    const createVoice = voiceSessions.createOrResumeClientVoiceSession;
    const intercepted = vi
      .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
      .mockImplementationOnce(async (...args) => {
        const id = await createVoice(...args);
        committed.resolve();
        await releaseCreation.promise;
        return id;
      });
    const close = prepareTalkConnectionClose([fixture.client], fixture.context.logGateway);
    const respond = vi.fn();
    const creating = invokeCreate({
      params: { sessionKey, provider: "openai", voiceSessionId },
      respond,
      context: fixture.context,
      client: fixture.client,
    } as never);
    let closing: Promise<void> | undefined;
    let closeFinished = false;
    try {
      await awaitGateBeforeSettlement(
        committed.promise,
        creating,
        "Browser creation did not commit",
      );
      closing = close.drain().then(() => {
        closeFinished = true;
      });
      await awaitGateBeforeSettlement(
        providerClosing.promise,
        closing,
        "Provider close did not start",
      );
      const reader = voiceWriters.captureClientVoiceSessionWriter({ agentId: "main" });
      try {
        await reader.read(voiceSessionId);
      } finally {
        await reader.release();
      }
      expect(closeFinished).toBe(false);
      releaseCreation.resolve();
      await Promise.all([creating, closing]);
      expect(respond.mock.lastCall?.[0]).toBe(false);
      expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
    } finally {
      releaseCreation.resolve();
      await Promise.allSettled([creating, closing, close.drain()]);
      intercepted.mockRestore();
    }
  });

  registerClientCreateSourceAuthorityTests({
    tempDir: () => tempDir,
    ownVoice: (id, key = sessionKey) => {
      ownedVoiceSessionId = id;
      ownedVoiceSessionKey = key;
    },
    configureProvider: configureDelegatedBrowserProvider,
    invokeCreate,
    observeAdmission: (observer) => {
      observeAdmission = observer;
    },
    sessionKey,
    sessionId,
  });
});
