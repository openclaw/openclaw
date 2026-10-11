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
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  listSessionReactions,
  setSessionReactionAsync,
} from "../../config/sessions/session-reaction-store.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { readUserTurnPromptReactionSource } from "../../sessions/user-turn-transcript-admission.js";
import { attachRuntimeUserTurnTranscriptContext } from "../../sessions/user-turn-transcript-runtime-context.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import {
  resolveMessageActionTurnAuthorization,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import { createChatRunState } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];

const admissionScenarios = [
  "removed",
  "replaced",
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
    const closure =
      scenario === "narrow-first-send"
        ? "rotated"
        : scenario === "dashboard-writer"
          ? "aborted"
          : dashboard
            ? "released"
            : scenario;
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
      const client: GatewayClient = {
        connId: "authoring-binding",
        connectionSignal: connection.signal,
        ...(dashboard && scenario !== "dashboard-unattested"
          ? {
              internal: {
                authenticatedControlUi: true as const,
                ...(scenario !== "dashboard-writer" && !membershipRequired
                  ? { controlUiAdmin: true as const }
                  : {}),
              },
            }
          : {}),
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes:
            scenario === "narrow-first-send"
              ? ["operator.sessions.write"]
              : scenario === "dashboard-writer" || membershipRequired
                ? ["operator.write"]
                : dashboard
                  ? ["operator.admin"]
                  : ["operator.read", "operator.write", "operator.admin"],
          client: dashboard
            ? { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" }
            : { id: "cli", version: "test", platform: "test", mode: "cli" },
        },
      };
      const namespaceRun = prepareSystemAgentRunAdmission({}, runId, "main", "test");
      const entered = createDeferred<DispatchOptions>();
      const release = createDeferred();
      const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      const holdDispatch = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async (options) => {
          entered.resolve(options);
          await release.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        });
      const context = {
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
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
      let owned: Parameters<typeof chatDispatch.startChatDispatch>[0] | undefined;
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      let successor: ReturnType<typeof registerChatAbortController> | undefined;
      let options: DispatchOptions | undefined;
      try {
        const respond = vi.fn();
        const params = {
          // Exercise the ordinary dashboard alias without an explicit agentId.
          sessionKey: scenario === "dashboard" ? "main" : sessionKey,
          message: "Keep this user turn in its session",
          idempotencyKey: runId,
        };
        const authorization = resolveSessionMutationAuthorization({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        expect(authorization.error).toBeNull();
        const sendChat = directDashboard ? handleDirectExternalChatSend : handleChatSend;
        const request = {
          params,
          req: { type: "req" as const, id: runId, method: "chat.send", params },
          respond,
          context,
          client,
          hasCurrentClientAuthority,
          sessionMutationAuthorization: authorization.authorization,
          isWebchatConnect: () => false,
        };
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
        if (!owned || !prepared || !runStarted || !capability) {
          throw new Error("chat.send did not hand off its prepared-session callback");
        }
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
        expect(original?.sessionId).toBe(initialSessionId);
        // This focused test controls preparation; the native WS test proves its real producer.
        await upsertSessionEntryCore(scope, {
          sessionId: membershipRequired ? initialSessionId : "committed-session",
          updatedAt: Date.now(),
          createdActor,
          ...(membershipRequired ? { visibility: "suggest" as const } : {}),
        });
        const committed = loadExactSessionEntryReadOnly(scope);
        if (!committed) {
          throw new Error("session writer did not commit");
        }
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
          expect(original?.sessionId).toBe(binding.sessionId);
          expect(admission.admittedSessionId).toBe(runId);
          expect(options.replyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
          expect(context.chatQueuedTurns.get(runId)?.sessionId).toBe(binding.sessionId);
          await userTurn.persist();
          expect(await loadTranscriptEvents({ ...scope, ...binding })).toContainEqual(
            expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
          );
          admission.cleanupAdmittedRun();
          expect(context.chatQueuedTurns.has(runId)).toBe(true);
        } else if (closure === "removed" || closure === "replaced") {
          admission.activeRunAbort.cleanup();
          if (closure === "replaced") {
            successor = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId,
              sessionKey,
              sessionId: "successor-session",
              timeoutMs: 60_000,
            });
          }
        } else if (closure === "aborted") {
          admission.activeRunAbort.controller.abort();
        } else if (closure === "released") {
          admission.gatewayWorkAdmission.release();
        } else if (closure === "terminal") {
          reply = createReplyOperation({
            sessionKey,
            sessionId: binding.sessionId,
            resetTriggered: false,
            upstreamAbortSignal: admission.activeRunAbort.controller.signal,
          });
          reply.complete();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        // No await after closure: release must fence even before its promise settles.
        expect(() => prepared({ ...binding, sessionId: "late-session" })).toThrow();
        if (dashboardRead) {
          expect(dashboardRead.assertCurrent).toThrow();
        }
        expect(original?.sessionId).toBe(binding.sessionId);
        expect(successor?.entry?.sessionId).toBe(
          closure === "replaced" ? "successor-session" : undefined,
        );
        if (closure === "queued") {
          await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
        } else if (closure === "released" || closure === "aborted" || closure === "rotated") {
          await expect(readLibrary()).rejects.toThrow();
        }
        if (closure !== "queued") {
          await upsertSessionEntryCore(scope, { sessionId: "late-session", updatedAt: Date.now() });
          await userTurn.persist();
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
        options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
        reply?.complete();
        successor?.cleanup();
        release.resolve();
        if (owned) {
          await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
          owned.admission.cleanupAdmittedRun();
          clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
        }
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      const client: GatewayClient = {
        connId: "reaction-source-client",
        connectionSignal: connection.signal,
        internal: { authenticatedControlUi: true },
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes: ["operator.write"],
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        },
      };
      const broadcast = vi.fn();
      const context = {
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        chatRunState: createChatRunState(),
        dedupe: new Map(),
        agentRunSeq: new Map(),
        getRuntimeConfig,
        addChatRun: vi.fn(),
        removeChatRun: (runId: string) => sources.get(runId)?.finished.resolve(),
        broadcast,
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      } as unknown as GatewayRequestContext;
      type Source = {
        entered: ReturnType<typeof createDeferred<DispatchOptions>>;
        release: ReturnType<typeof createDeferred<void>>;
        finished: ReturnType<typeof createDeferred<void>>;
        owned?: Parameters<typeof chatDispatch.startChatDispatch>[0];
        options?: DispatchOptions;
      };
      const sources = new Map<string, Source>();
      const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      const holdDispatch = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async (options) => {
          const source = sources.get(options.ctx.MessageSid ?? "");
          if (!source) {
            throw new Error("Unexpected source dispatch");
          }
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
      let probe: ReturnType<typeof sqliteWorkerOwnerProbe.admission> | undefined;
      async function sendPrompt(runId: string, message: string) {
        const source: Source = {
          entered: createDeferred<DispatchOptions>(),
          release: createDeferred(),
          finished: createDeferred(),
        };
        sources.set(runId, source);
        const params = { sessionKey, message, idempotencyKey: runId };
        const authorization = resolveSessionMutationAuthorization({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        expect(authorization.error).toBeNull();
        const respond = vi.fn();
        await handleDirectExternalChatSend({
          params,
          req: { type: "req", id: runId, method: "chat.send", params },
          respond,
          context,
          client,
          sessionMutationAuthorization: authorization.authorization,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId, status: "started" }),
          undefined,
          expect.anything(),
        );
        const options = await source.entered.promise;
        const owned = observeDispatch.mock.calls.at(-1)?.[0];
        if (!owned || !options.replyOptions?.dashboardReadAdmission) {
          throw new Error("Direct authenticated chat did not capture its source");
        }
        source.owned = owned;
        source.options = options;
        options.replyOptions.onSessionPrepared?.({
          sessionKey,
          sessionId,
          storePath: owned.session.storePath,
        });
        const promptSource = readUserTurnPromptReactionSource(owned.userTurn.recorder);
        expect(promptSource).toBeDefined();
        promptSource?.assertCurrent();
        return { ...source, owned, options };
      }
      try {
        const initial = await sendPrompt("reaction-original-source", "Original prompt");
        const initialRecorder = initial.owned.userTurn.recorder;
        const lifecycle = initial.options.replyOptions?.turnAdoptionLifecycle;
        if (mode === "queued") {
          expect(lifecycle?.onDeferred?.()).toBe(true);
          await lifecycle?.onAdopted();
        }
        await initial.owned.userTurn.persist();
        const original = initialRecorder.getAdmissionReceipt();
        if (!original) {
          throw new Error("Original prompt did not commit");
        }
        if (mode === "queued") {
          initial.owned.admission.cleanupAdmittedRun();
          expect(context.chatQueuedTurns.has("reaction-original-source")).toBe(true);
        }
        const config = getRuntimeConfig();
        token = mintReplyMessageActionTurnCapability(
          {
            followupRun: {
              prompt: "Original prompt",
              enqueuedAt: 0,
              userTurnTranscriptRecorder: initialRecorder,
              run: {
                ...scope,
                sessionFile: sessionKey,
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                config,
                provider: "openai",
                model: "test",
                messageProvider: "webchat",
                timeoutMs: 1000,
                blockReplyBreak: "message_end",
              },
            },
            sessionCtx: { Provider: "webchat" },
            // Deliberately offer the original read admission. It must not transfer to this run.
            opts: { dashboardReadAdmission: initial.options.replyOptions?.dashboardReadAdmission },
            isHeartbeat: false,
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
        const external = vi.fn();
        const tool = createMessageTool({
          config,
          preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
          agentId: "main",
          agentSessionKey: sessionKey,
          sessionId,
          runId: executionRunId,
          currentChannelProvider: "webchat",
          messageActionTurnCapability: token,
          runMessageAction: external,
          getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
          resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
            resolvedConfig,
            diagnostics: [],
            targetStatesByPath: {},
            hadUnresolvedTargets: false,
          }),
        });
        const react = (args: Record<string, unknown> = {}) =>
          withGatewayToolCallerIdentity(caller, () =>
            tool.execute("authenticated-react", { action: "react", emoji: "👍", ...args }),
          );
        let prompt = initialRecorder;
        if (mode === "steered") {
          const steering = await sendPrompt("reaction-steered-source", "Steered prompt");
          prompt = steering.owned.userTurn.recorder;
          expect(prompt.getAdmissionReceipt()).toBeUndefined();
          expect((await react({ dryRun: true })).details).toMatchObject({
            messageId: original.entryId,
          });
          const prepared = await prompt.resolveMessage();
          if (!prepared) {
            throw new Error("Steered prompt was not staged");
          }
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
        if (!messageId) {
          throw new Error("Consumed prompt did not commit");
        }
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
          if (request.stage === "prepare" && outcome === "member-revoked" && !preparationRevoked) {
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
          expect(broadcast.mock.calls.filter(([event]) => event === "session.reaction")).toEqual([
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
          expect(broadcast.mock.calls.filter(([event]) => event === "session.reaction")).toEqual(
            [],
          );
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
          source.options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
          source.release.resolve();
        }
        await Promise.all(
          [...sources.values()]
            .filter((source) => source.owned)
            .map((source) => source.finished.promise),
        );
        for (const [runId, source] of sources) {
          source.owned?.admission.cleanupAdmittedRun();
          if (source.owned) {
            clearAgentRunContext(runId, source.owned.admission.lifecycleGeneration);
          }
        }
        holdDispatch.mockRestore();
        observeDispatch.mockRestore();
      }
    });
  },
);
