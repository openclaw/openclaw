import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { mintReplyMessageActionTurnCapability } from "../../auto-reply/reply/agent-runner-utils.js";
import {
  createQueueTestRun,
  createQueueSettings,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
} from "../../auto-reply/reply/queue/lifecycle.js";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  commitReplySessionInitialization,
  loadExactSessionEntryReadOnly,
  loadReplySessionInitializationSnapshot,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { setSessionReactionAsync } from "../../config/sessions/session-reaction-store.js";
import { listSessionReactions } from "../../config/sessions/session-reaction-store.test-support.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  bindSessionControllerSource,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  isRpcSourceQueued,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { readUserTurnPromptReactionSource } from "../../sessions/user-turn-transcript-admission.js";
import { attachRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveMessageActionTurnAuthorization,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import { createChatRunState } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { holdProjectedChatDispatch } from "./chat-send-authority.test-support.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];

function createBindingContext() {
  return {
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getRuntimeConfig,
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestContext;
}

function createBindingClient(options: {
  profileId: string;
  signal: AbortSignal;
  scopes: string[];
  dashboard: boolean;
  attested?: boolean;
  admin?: boolean;
}): GatewayClient {
  return {
    connId: "authoring-binding",
    connectionSignal: options.signal,
    ...(options.dashboard && options.attested !== false
      ? {
          internal: {
            authenticatedControlUi: true as const,
            ...(options.admin ? { controlUiAdmin: true as const } : {}),
          },
        }
      : {}),
    authenticatedUserProfile: gatewayProfile(options.profileId),
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: options.scopes,
      client: options.dashboard
        ? { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" }
        : { id: "cli", version: "test", platform: "test", mode: "cli" },
    },
  };
}

async function prepareBindingRequest(
  params: { sessionKey: string; message: string; idempotencyKey: string },
  client: GatewayClient,
  context: GatewayRequestContext,
) {
  const authorization = await resolveSessionMutationAuthorizationAsync({
    client,
    context,
    method: "chat.send",
    requestParams: params,
  });
  expect(authorization.error).toBeNull();
  return {
    params,
    client,
    context,
    respond: vi.fn(),
    req: { type: "req" as const, id: params.idempotencyKey, method: "chat.send", params },
    sessionMutationAuthorization: authorization.authorization,
    isWebchatConnect: () => false,
  };
}

const admissionScenarios = [
  "removed",
  "aborted",
  "released",
  "terminal",
  "rotated",
  "queued",
  "narrow-first-send",
  "dashboard",
  "dashboard-writer",
  "dashboard-credential-revoked",
  "dashboard-member-revoked",
  "dashboard-unattested",
  "dashboard-internal",
] as const;

it.each(admissionScenarios)(
  "keeps prepared-session binding with its exact admission: %s",
  async (scenario) => {
    const dashboard = scenario.startsWith("dashboard");
    const directDashboard = dashboard && scenario !== "dashboard-internal";
    const dashboardReadAllowed = directDashboard && scenario !== "dashboard-unattested";
    const membershipRequired = scenario === "dashboard-member-revoked";
    const createsDashboardSession = dashboardReadAllowed && !membershipRequired;
    const closure =
      scenario === "narrow-first-send"
        ? "rotated"
        : scenario === "dashboard-writer"
          ? "aborted"
          : dashboard
            ? "released"
            : scenario;
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      await loadOrCreateProcessDeviceIdentityAsync();
      setRuntimeConfigSnapshot({});
      const runId = "retained-preparation";
      const sessionKey = scenario === "dashboard" ? "agent:main:main" : "agent:main:binding";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated-session", updatedAt: Date.now() },
      );
      const clone = vi.spyOn(globalThis, "structuredClone");
      const unrelatedCloneCount = () =>
        clone.mock.calls.filter(
          ([entry]) =>
            entry &&
            typeof entry === "object" &&
            "sessionId" in entry &&
            entry.sessionId === "unrelated-session",
        ).length;
      const profile = ensureProfileForEmail("authoring-binding@example.test");
      const owner = membershipRequired
        ? ensureProfileForEmail("authoring-owner@example.test")
        : profile;
      const initialSessionId = membershipRequired ? "member-session" : runId;
      const createdActor = { type: "human", source: "profile", id: owner.id } as const;
      if (membershipRequired) {
        await upsertSessionEntryCore(scope, {
          sessionId: initialSessionId,
          updatedAt: Date.now(),
          visibility: "suggest",
          createdActor,
        });
        addSessionMember(scope, { identityId: profile.id, addedBy: owner.id });
      }
      const connection = new AbortController();
      const hasCurrentClientAuthority = vi.fn(() => true);
      const client = createBindingClient({
        profileId: profile.id,
        signal: connection.signal,
        dashboard,
        attested: scenario !== "dashboard-unattested",
        admin: scenario !== "dashboard-writer" && !membershipRequired,
        scopes:
          scenario === "narrow-first-send"
            ? ["operator.sessions.write"]
            : scenario === "dashboard-writer" || membershipRequired
              ? ["operator.write"]
              : dashboard
                ? ["operator.admin"]
                : ["operator.read", "operator.write", "operator.admin"],
      });
      const namespaceRun = prepareSystemAgentRunAdmission({}, runId, "main", "test");
      const {
        entered,
        release,
        observe: observeDispatch,
        hold: holdDispatch,
      } = holdProjectedChatDispatch();
      const context = createBindingContext();
      let owned: Parameters<typeof chatDispatch.startChatDispatch>[0] | undefined;
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      let options: DispatchOptions | undefined;
      let releaseAuthorization: (() => void) | undefined;
      let queuedRun: ReturnType<typeof createQueueTestRun> | undefined;
      try {
        const params = {
          // Exercise the ordinary dashboard alias without an explicit agentId.
          sessionKey: scenario === "dashboard" ? "main" : sessionKey,
          message: "Keep this user turn in its session",
          idempotencyKey: runId,
        };
        const request = {
          ...(await prepareBindingRequest(params, client, context)),
          hasCurrentClientAuthority,
        };
        releaseAuthorization = request.sessionMutationAuthorization?.release;
        const { respond } = request;
        const sendChat = directDashboard ? handleDirectExternalChatSend : handleChatSend;
        if (scenario === "narrow-first-send") {
          await handleGatewayRequest({
            ...request,
            extraHandlers: { "chat.send": handleChatSend },
          });
        } else {
          await sendChat(request);
        }
        expect(respond).toHaveBeenCalledWith(
          true,
          dashboard
            ? expect.objectContaining({ runId, status: "started" })
            : { runId, status: "started" },
          undefined,
          expect.anything(),
        );
        options = await entered.promise;
        const dashboardRead = options.replyOptions?.dashboardReadAdmission;
        expect(Boolean(dashboardRead)).toBe(dashboardReadAllowed);
        owned = observeDispatch.mock.calls.at(-1)?.[0];
        expect(Boolean(readUserTurnPromptReactionSource(owned?.userTurn.recorder))).toBe(
          dashboardReadAllowed,
        );
        const prepared = options.replyOptions?.onSessionPrepared;
        const runStarted = options.replyOptions?.onAgentRunStart;
        const capability = options.replyOptions?.skillLibraryAuthoring;
        assert(owned && prepared && runStarted && capability);
        // Initial resolution needs detached entries; later admission must not clone unrelated rows.
        expect.soft(unrelatedCloneCount()).toBeLessThanOrEqual(1);
        const admittedContext = await namespaceRun.admit("embedded");
        capability.bind(admittedContext);
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admittedContext,
          agentId: "main",
          sessionKey,
        });
        const readLibrary = () =>
          withGatewayToolCallerIdentity(caller, () => capability.invoke({ action: "list" }));
        const { admission, userTurn } = owned;
        const original = admission.activeRunAbort.entry;
        expect(original && getRpcSourceIdentity(original).sessionId).toBe(initialSessionId);
        const preparedEntry = {
          sessionId: dashboard ? initialSessionId : "committed-session",
          updatedAt: Date.now(),
          createdActor,
          ...(membershipRequired ? { visibility: "suggest" as const } : {}),
        };
        if (createsDashboardSession) {
          const creationScope = { ...scope, storePath: owned.session.storePath };
          const snapshot = await loadReplySessionInitializationSnapshot(creationScope);
          const bindCreation = options.replyOptions?.bindSessionCreation;
          const onCreated = options.replyOptions?.onSessionCreated;
          assert(bindCreation && onCreated);
          const result = await commitReplySessionInitialization({
            ...creationScope,
            activeSessionKey: sessionKey,
            expectedRevision: snapshot.revision,
            sessionEntry: preparedEntry,
            bindCreation,
            onCreated,
          });
          expect(result.ok).toBe(true);
        } else {
          // Replacement scenarios control preparation independently of creation.
          await upsertSessionEntryCore(scope, preparedEntry);
        }
        const committed = loadExactSessionEntryReadOnly(scope);
        assert(committed, "session writer did not commit");
        const binding = {
          sessionKey,
          sessionId: committed.entry.sessionId,
          storePath: owned.session.storePath,
        };
        prepared(binding);
        prepared(binding);
        prepared({ ...binding, sessionKey: "agent:main:unrelated", sessionId: "foreign" });
        if (dashboardRead) {
          expect(admission.admittedSessionId).toBe(initialSessionId);
          expect(dashboardRead.sessionId).toBe(binding.sessionId);
          await dashboardRead.prepare?.();
          dashboardRead.assertCurrent();
        }
        clone.mockClear();
        runStarted(runId);
        expect.soft(unrelatedCloneCount()).toBe(0);
        await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
        if (dashboardRead) {
          connection.abort();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
          expect(dashboardRead.assertCurrent).not.toThrow();
          if (scenario === "dashboard-credential-revoked") {
            hasCurrentClientAuthority.mockReturnValue(false);
            expect(dashboardRead.assertCurrent).toThrow(
              "Dashboard message read admission is no longer active.",
            );
          } else if (membershipRequired) {
            removeSessionMember(scope, profile.id, undefined, binding.sessionId);
            expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
            expect(hasCurrentClientAuthority()).toBe(true);
            expect(dashboardRead.assertCurrent).toThrow("session is suggest for this connection");
          }
        }

        if (closure === "queued") {
          expect(original && getRpcSourceIdentity(original).sessionId).toBe(binding.sessionId);
          expect(admission.admittedSessionId).toBe(runId);
          if (!original) {
            throw new Error("Expected accepted source");
          }
          queuedRun = createQueueTestRun({ prompt: params.message });
          queuedRun.turnAdoptionLifecycle = options.replyOptions?.turnAdoptionLifecycle;
          bindSessionControllerSource(original.input, queuedRun);
          expect(
            enqueueFollowupRun(
              sessionKey,
              queuedRun,
              createQueueSettings(),
              "none",
              undefined,
              false,
            ),
          ).toBe(true);
          const source = rpcSourceTesting.get(runId);
          expect(source && getRpcSourceIdentity(source).sessionId).toBe(binding.sessionId);
          await userTurn.persist();
          expect(await loadTranscriptEvents({ ...scope, ...binding })).toContainEqual(
            expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
          );
          admission.cleanupAdmittedRun();
          expect(rpcSourceTesting.has(runId)).toBe(true);
        } else if (closure === "removed") {
          admission.activeRunAbort.cleanup();
        } else if (closure === "aborted") {
          admission.activeRunAbort.controller.abort();
        } else if (closure === "released") {
          admission.gatewayWorkAdmission.release();
        } else if (closure === "terminal") {
          if (!original) {
            throw new Error("Expected accepted source");
          }
          await claimSessionControllerTask(original.input, (claim) => {
            reply = createReplyOperation({
              mailboxClaim: claim,
              target: original.input.mailbox.owner.target,
              sessionKey,
              sessionId: binding.sessionId,
              resetTriggered: false,
              upstreamAbortSignal: admission.activeRunAbort.controller.signal,
            });
            reply.complete();
            releaseSessionControllerClaim(claim);
          });
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
          // The finished runtime still owns its source until the held dispatch settles.
          expect(rpcSourceTesting.get(runId)).toBe(original);
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        // No await after closure: release must fence even before its promise settles.
        expect(() => prepared({ ...binding, sessionId: "late-session" })).toThrow();
        if (dashboardRead) {
          expect(dashboardRead.assertCurrent).toThrow();
        }
        expect(original && getRpcSourceIdentity(original).sessionId).toBe(binding.sessionId);
        if (closure === "queued") {
          await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
        } else if (closure === "released" || closure === "aborted" || closure === "rotated") {
          await expect(readLibrary()).rejects.toThrow();
        }
        if (closure !== "queued") {
          await upsertSessionEntryCore(scope, { sessionId: "late-session", updatedAt: Date.now() });
          if (membershipRequired) {
            // The pre-ACK commit survives revocation; replay cannot append to the successor.
            await expect(userTurn.persist()).resolves.toMatchObject({
              admission: { sessionId: binding.sessionId, sessionKey },
              message: { role: "user", content: "Keep this user turn in its session" },
            });
          } else if (closure === "released") {
            await expect(userTurn.persist()).rejects.toThrow("Chat input actor admission ended");
          } else {
            await userTurn.persist();
          }
          expect(
            await loadTranscriptEvents({
              ...scope,
              sessionId: "late-session",
              storePath: binding.storePath,
            }),
          ).toEqual([]);
        }
      } finally {
        namespaceRun.close();
        reply?.complete();
        release.resolve();
        if (queuedRun) {
          completeFollowupRunLifecycle(queuedRun);
          await queuedRun.controllerInput?.settlement.promise;
        } else {
          await options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
        }
        if (owned) {
          await vi.waitFor(() => expect(rpcSourceTesting.has(runId)).toBe(false));
          owned.admission.cleanupAdmittedRun();
          clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
        }
        releaseAuthorization?.();
        holdDispatch.mockRestore();
        observeDispatch.mockRestore();
        clone.mockRestore();
      }
    });
  },
);

const reactionSourceScenarios = ["allowed", "credential-revoked", "member-revoked"] as const;

it.each(
  (["queued", "steered"] as const).flatMap((mode) =>
    reactionSourceScenarios.map((outcome) => ({ mode, outcome })),
  ),
)(
  "keeps authenticated $mode prompt reactions scoped through SQLite ($outcome)",
  async ({ mode, outcome }) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        await loadOrCreateProcessDeviceIdentityAsync();
        setRuntimeConfigSnapshot({});
        const sessionKey = "agent:main:reaction-source";
        const sessionId = "reaction-source-session";
        const scope = { agentId: "main", sessionKey, sessionId };
        const profile = ensureProfileForEmail("reaction-member@example.test");
        const owner = ensureProfileForEmail("reaction-owner@example.test");
        // Membership is necessary even in the positive/credential cases: no admin or owner bypass.
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1,
          visibility: "suggest",
          createdActor: { type: "human", source: "profile", id: owner.id },
        });
        addSessionMember(scope, { identityId: profile.id, addedBy: owner.id });
        const connection = new AbortController();
        const client = createBindingClient({
          profileId: profile.id,
          signal: connection.signal,
          dashboard: true,
          scopes: ["operator.write"],
        });
        client.connId = "reaction-source-client";
        const broadcast = vi.fn();
        const reactionEvents = () =>
          broadcast.mock.calls.filter(([event]) => event === "session.reaction");
        const context = createBindingContext();
        context.removeChatRun = (runId: string) => {
          sources.get(runId)?.finished.resolve();
          return undefined;
        };
        context.broadcast = broadcast;
        type Source = {
          entered: ReturnType<typeof createDeferred<DispatchOptions>>;
          release: ReturnType<typeof createDeferred<void>>;
          finished: ReturnType<typeof createDeferred<void>>;
          owned?: Parameters<typeof chatDispatch.startChatDispatch>[0];
          options?: DispatchOptions;
          releaseAuthorization?: () => void;
        };
        const sources = new Map<string, Source>();
        const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
        const holdDispatch = vi
          .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
          .mockImplementation(async (options) => {
            const source = sources.get(options.ctx.MessageSid ?? "");
            assert(source, "Unexpected source dispatch");
            source.entered.resolve(options);
            await source.release.promise;
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          });
        const executionRunId = "reaction-adopted-execution";
        const execution = prepareSystemAgentRunAdmission(
          getRuntimeConfig(),
          executionRunId,
          "main",
          "authenticated-reaction-proof",
        );
        let token: string | undefined;
        let queuedReaction: ReturnType<typeof createQueueTestRun> | undefined;
        let probe: ReturnType<typeof sqliteWorkerOwnerProbe.admission> | undefined;
        async function sendPrompt(runId: string, message: string, queueMode?: "steer") {
          const source: Source = {
            entered: createDeferred<DispatchOptions>(),
            release: createDeferred(),
            finished: createDeferred(),
          };
          sources.set(runId, source);
          const params = {
            sessionKey,
            message,
            idempotencyKey: runId,
            ...(queueMode ? { queueMode } : {}),
          };
          const request = await prepareBindingRequest(params, client, context);
          source.releaseAuthorization = request.sessionMutationAuthorization?.release;
          const { respond } = request;
          await handleDirectExternalChatSend(request);
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ runId, status: "started" }),
            undefined,
            expect.anything(),
          );
          const options = await source.entered.promise;
          const owned = observeDispatch.mock.calls.at(-1)?.[0];
          assert(owned && options.replyOptions?.dashboardReadAdmission);
          source.owned = owned;
          source.options = options;
          options.replyOptions.onSessionPrepared?.({
            sessionKey,
            sessionId,
            storePath: owned.session.storePath,
          });
          const promptSource = readUserTurnPromptReactionSource(owned.userTurn.recorder);
          expect(promptSource).toBeDefined();
          await promptSource?.prepare?.();
          promptSource?.assertCurrent();
          return { ...source, owned, options };
        }
        const external = vi
          .spyOn(messageActionRunner, "runMessageAction")
          .mockRejectedValue(new Error("Unexpected external message action"));
        try {
          const initial = await sendPrompt("reaction-original-source", "Original prompt");
          const initialRecorder = initial.owned.userTurn.recorder;
          const lifecycle = initial.options.replyOptions?.turnAdoptionLifecycle;
          if (mode === "queued") {
            queuedReaction = createQueueTestRun({ prompt: "Original prompt" });
            queuedReaction.run = {
              ...queuedReaction.run,
              ...scope,
              sessionId,
              config: {
                ...getRuntimeConfig(),
                session: { store: initial.owned.session.storePath },
              },
            };
            queuedReaction.turnAdoptionLifecycle = lifecycle;
            bindSessionControllerSource(initial.owned.admission.sourceRef.input, queuedReaction);
            expect(
              enqueueFollowupRun(sessionKey, queuedReaction, createQueueSettings(), "none"),
            ).toBe(true);
            await admitFollowupRunLifecycle(queuedReaction);
          }
          await initial.owned.userTurn.persist();
          const original = initialRecorder.getAdmissionReceipt();
          assert(original, "Original prompt did not commit");
          if (mode === "queued") {
            initial.owned.admission.cleanupAdmittedRun();
            expect(isRpcSourceQueued(initial.owned.admission.sourceRef)).toBe(true);
          }
          const config = getRuntimeConfig();
          const followupRun = createQueueTestRun({ prompt: "Original prompt" });
          followupRun.userTurnTranscriptRecorder = initialRecorder;
          followupRun.run = {
            ...followupRun.run,
            ...scope,
            sessionFile: sessionKey,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            config,
            messageProvider: "webchat",
          };
          token = mintReplyMessageActionTurnCapability(
            {
              followupRun,
              sessionCtx: { Provider: "webchat" },
              // Deliberately offer the original read admission. It must not transfer to this run.
              opts: {
                dashboardReadAdmission: initial.options.replyOptions?.dashboardReadAdmission,
              },
            },
            executionRunId,
          );
          expect(token).toBeTruthy();
          expect(
            resolveMessageActionTurnAuthorization({ ...scope, runId: executionRunId, token })
              ?.assertDashboardReadCurrent,
          ).toBeUndefined();
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: await execution.admit("embedded"),
            agentId: "main",
            sessionKey,
          });
          const tool = createMessageTool({
            config,
            preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
            agentId: "main",
            agentSessionKey: sessionKey,
            sessionId,
            runId: executionRunId,
            currentChannelProvider: "webchat",
            messageActionTurnCapability: token,
          });
          const react = (args: Record<string, unknown> = {}) =>
            withGatewayToolCallerIdentity(caller, () =>
              tool.execute("authenticated-react", { action: "react", emoji: "👍", ...args }),
            );
          let prompt = initialRecorder;
          if (mode === "steered") {
            const steering = await sendPrompt("reaction-steered-source", "Steered prompt", "steer");
            prompt = steering.owned.userTurn.recorder;
            expect(prompt.getAdmissionReceipt()).toBeUndefined();
            expect((await react({ dryRun: true })).details).toMatchObject({
              messageId: original.entryId,
            });
            const prepared = await prompt.resolveMessage();
            assert(prepared, "Steered prompt was not staged");
            const manager = guardSessionManager(
              await SessionManager.openAsync(
                { ...scope, storePath: original.storePath },
                state.workspaceDir,
              ),
              { ...scope, runId: executionRunId, config },
            );
            await manager.appendMessageAsync(
              attachRuntimeUserTurnTranscriptContext(makeUserMessage("Steered prompt", 2), {
                message: prepared,
                recorder: prompt,
              }),
            );
            expect(prompt.isPendingInputConsumed?.()).toBe(true);
            expect(prompt.getAdmissionReceipt()?.entryId).not.toBe(original.entryId);
          }
          const messageId = prompt.getAdmissionReceipt()?.entryId;
          assert(messageId, "Consumed prompt did not commit");
          // Existing human rows use the same durable store before any agent reaction.
          await setSessionReactionAsync(scope, {
            messageId,
            emoji: "👍",
            identityId: profile.id,
            identityLabel: "Human",
            expectedSessionId: sessionId,
          });
          const before = listSessionReactions(scope, { sessionId });
          expect(before[messageId]).toEqual([
            { emoji: "👍", count: 1, identities: [{ id: profile.id, label: "Human" }] },
          ]);
          // A disconnected transport is not a revoked credential.
          connection.abort();
          readUserTurnPromptReactionSource(prompt)?.assertCurrent();
          let commitRequests = 0;
          let preparationRevoked = false;
          probe = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
            if (request.stage === "commit") {
              commitRequests++;
              if (outcome === "credential-revoked") {
                client.invalidated = true;
              }
            }
            if (
              request.stage === "prepare" &&
              outcome === "member-revoked" &&
              !preparationRevoked
            ) {
              // Remove membership before the reaction worker takes BEGIN IMMEDIATE;
              // deleting from the same database at its commit checkpoint would deadlock.
              preparationRevoked = true;
              expect(removeSessionMember(scope, profile.id, undefined, sessionId)).not.toBeNull();
            }
            admit(request, grant);
          });
          if (outcome === "allowed") {
            expect((await react()).details).toMatchObject({ messageId, changed: true });
            expect(commitRequests).toBeGreaterThan(0);
            expect(listSessionReactions(scope, { sessionId })[messageId]).toEqual([
              {
                emoji: "👍",
                count: 2,
                identities: expect.arrayContaining([
                  { id: profile.id, label: "Human" },
                  { id: "agent:main", label: expect.any(String) },
                ]),
              },
            ]);
            expect(reactionEvents()).toEqual([
              [
                "session.reaction",
                expect.objectContaining({
                  messageId,
                  action: "added",
                  actor: expect.objectContaining({ type: "agent", id: "main" }),
                }),
                { sessionKeys: [sessionKey], agentId: "main" },
              ],
            ]);
          } else {
            await expect(react()).rejects.toThrow(
              outcome === "credential-revoked"
                ? "Dashboard message read admission is no longer active."
                : "session is suggest for this connection",
            );
            if (outcome === "credential-revoked") {
              expect(commitRequests).toBeGreaterThan(0);
            } else {
              expect(preparationRevoked).toBe(true);
            }
            expect(listSessionReactions(scope, { sessionId })).toEqual(before);
            expect(reactionEvents()).toEqual([]);
          }
          probe.mockRestore();
          if (outcome === "allowed") {
            await react({ remove: true });
            expect(listSessionReactions(scope, { sessionId })).toEqual(before);
          }
          expect(external).not.toHaveBeenCalled();
        } finally {
          probe?.mockRestore();
          revokeMessageActionTurnCapability(token);
          execution.close();
          for (const source of sources.values()) {
            source.release.resolve();
          }
          if (queuedReaction) {
            completeFollowupRunLifecycle(queuedReaction);
            await queuedReaction.controllerInput?.settlement.promise;
          }
          await Promise.all(
            [...sources.values()].map(async (source) => {
              const settled = source.options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
              await settled;
              if (source.owned) {
                await source.finished.promise;
              }
            }),
          );
          for (const [runId, source] of sources) {
            source.owned?.admission.cleanupAdmittedRun();
            source.releaseAuthorization?.();
            if (source.owned) {
              clearAgentRunContext(runId, source.owned.admission.lifecycleGeneration);
            }
          }
          holdDispatch.mockRestore();
          observeDispatch.mockRestore();
          external.mockRestore();
        }
      },
    );
  },
);
