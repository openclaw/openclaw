import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { normalizeProviderModelRef } from "../../agents/embedded-agent-runner/model.registry-resolution.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { FailoverError } from "../../agents/failover-error.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  bindReplyInputChannel,
  createAgentQuestionAnswerAuthority,
  prepareReplyToolAuthorityCallerRead,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as metadata from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import * as registryState from "../../sessions/session-controller.state.js";
import { createCommandTurnContext } from "../command-turn-context.js";
import { bindRequesterProfile, transferRequesterProfile } from "../requester-profile.js";
import { bindReplyFallbackSteeringRoute } from "./agent-runner-fallback-authority.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import * as followupRunner from "./followup-runner.js";
import { createPersonalToolScreenDispatcher } from "./personal-tool-turn.test-support.js";
import { getFollowupQueueDepth, type FollowupRun } from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { resolveReplySteeringIntent } from "./reply-steering-intent.js";
import * as toolAuthority from "./reply-tool-authority.js";
import { prepareReplyRunToolAuthority, prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createQueueTestRun } from "./reply-tool-authority.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createMockTypingController, createReplyParams } from "./test-helpers.js";

afterEach(() => vi.restoreAllMocks());

type ReplyParams = Parameters<typeof runReplyAgent>[0];

function steer(run: FollowupRun, key: string, overrides: Partial<ReplyParams>) {
  return runReplyAgent(
    createReplyParams(run, {
      transcriptCommandBody: undefined,
      queueKey: key,
      resolvedQueue: { mode: "steer", debounceMs: 0 },
      shouldSteer: true,
      isActive: true,
      sessionKey: key,
      defaultModel: "gpt-test",
      resolvedBlockStreamingBreak: "text_end",
      ...overrides,
    }),
  );
}

function operator(run: FollowupRun, profileId: string, assertCurrent = () => {}) {
  return createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.read", "operator.write"],
    gatewayAccessGrant: null,
    modelPolicy: prepareOperatorModelPolicy({ cfg: run.run.config, policy: {} }),
    assertCurrent,
  });
}

describe("ordinary steering into automatic model fallback", () => {
  it.each(["linked text", "linked image", "linked operator image", "same surface"] as const)(
    "keeps question authority separate from ordinary steering: %s",
    async (scenario) => {
      const linked = scenario !== "same surface";
      const key = `agent:main:steering-question-${scenario.replaceAll(" ", "-")}`;
      const run = createQueueTestRun({ prompt: "Continue", messageId: "owner-answer" });
      Object.assign(run.run, {
        agentId: "main",
        sessionKey: key,
        conversationId: "owner-chat",
        senderIsOwner: true,
        traceAuthorized: true,
        gitContributorProfileId: "alice",
      });
      run.run.config = { messages: { queue: { allowCollaborativeSteering: false } } };
      const taskSuggestionDeliveryMode = scenario === "linked text" ? "gateway" : undefined;
      run.run.taskSuggestionDeliveryMode = taskSuggestionDeliveryMode;
      run.operatorAuthority = operator(run, "alice");
      const ownerContext = {
        Provider: "telegram",
        SessionKey: key,
        ChatId: "owner-chat",
        SenderId: run.run.senderId,
      };
      bindRequesterProfile(ownerContext, {
        id: "alice",
        displayName: null,
        isCurrent: () => true,
      });
      transferRequesterProfile(ownerContext, run);
      bindReplyInputChannel(run.run, ownerContext.Provider);
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: run.run.sessionId,
        resetTriggered: false,
      });
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyRunToolAuthority(run, undefined));
      const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
      const assertActive = () => operation.abortSignal.throwIfAborted();
      const authority = createAgentQuestionAnswerAuthority({
        sessionKey: key,
        fingerprint,
        project: (caller) => operation.projectToolAuthorityFingerprint(caller),
        prepareCaller: (caller) =>
          prepareReplyToolAuthorityCallerRead(
            operation.projectToolAuthorityFingerprintAsync,
            caller,
            fingerprint,
            run.run,
            assertActive,
          ),
        assertActive,
      });
      const answer = vi.fn(async () => ({ status: "answered" }));
      const question = withAgentQuestionAnswerAuthority(authority, () =>
        registerPendingAgentQuestion({
          questionId: `${key}-question`,
          sessionKey: key,
          questions: [{ id: "answer", header: "Answer", question: "Continue?", options: [] }],
          gatewayCall: { version: 2, call: answer },
          answer: Promise.resolve({ status: "pending" }),
        }),
      );
      question.attachRegistration(Promise.resolve());
      const nativeSteer = vi.fn(async () => {});
      operation.attachBackend({
        kind: "embedded",
        taskSuggestionDeliveryMode,
        terminalReplyExpectation: "required",
        supportsTranscriptCommitWait: true,
        supportsQueueMessageImages: true,
        cancel() {},
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage: (text, options, assertCurrent, kind) =>
            steerActiveSessionWithOptionalDeliveryWait(
              { steer: nativeSteer, subscribe: () => () => {} },
              text,
              // This fixed session commits synchronously; transcript waiting has separate coverage.
              { ...options, waitForTranscriptCommit: undefined, onQueueSettled: undefined },
              key,
              () => {
                assertCurrent();
                return true;
              },
              { kind, assertCurrent },
            ),
        },
      });
      operation.setPhase("running");
      try {
        const incoming: FollowupRun = { ...run, run: { ...run.run } };
        const context = linked
          ? {
              ...ownerContext,
              Provider: "whatsapp",
              ChatId: "linked-chat",
              SenderId: "linked-alice",
            }
          : ownerContext;
        if (linked) {
          incoming.operatorAuthority =
            scenario === "linked operator image" ? run.operatorAuthority : undefined;
          incoming.run.messageProvider = "whatsapp";
          incoming.run.conversationId = context.ChatId;
          incoming.run.senderId = context.SenderId;
          incoming.run.senderIsOwner = false;
          incoming.run.traceAuthorized = false;
          incoming.toolsAllow = ["read"];
          // Crossing surfaces retains the incumbent tools in either direction.
          incoming.run.taskSuggestionDeliveryMode =
            scenario === "linked operator image" ? "gateway" : undefined;
          bindRequesterProfile(context, { id: "alice", displayName: null, isCurrent: () => true });
        }
        if (scenario.endsWith("image")) {
          incoming.images = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
        }
        await steer(incoming, key, {
          steeringIntent: { kind: "continue-existing" },
          sessionCtx: context,
        });
        expect(question.isCancellationRequested()).toBe(false);
        expect(nativeSteer).toHaveBeenCalledTimes(linked ? 1 : 0);
        expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
        expect(answer).toHaveBeenCalledTimes(linked ? 0 : 1);
        if (linked) {
          await steer({ ...run, messageId: "later-owner-answer", run: { ...run.run } }, key, {
            sessionCtx: ownerContext,
          });
          expect(answer).toHaveBeenCalledOnce();
          expect(nativeSteer).toHaveBeenCalledOnce();
        }
        expect(answer).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "question.resolve",
            params: expect.objectContaining({ answers: { answers: { answer: ["Continue"] } } }),
          }),
        );
      } finally {
        question.dispose();
        clearSessionQueues([key]);
        operation.complete();
      }
    },
  );

  it.each([
    { preparation: "fingerprint-1", revoked: false, aborted: false, replaceBackend: false },
    { preparation: "fingerprint-2", revoked: false, aborted: false, replaceBackend: false },
    { preparation: "fingerprint-1", revoked: true, aborted: false, replaceBackend: false },
    { preparation: "fingerprint-2", revoked: true, aborted: false, replaceBackend: false },
    { preparation: "fingerprint-1", revoked: false, aborted: true, replaceBackend: false },
    { preparation: "fingerprint-1", revoked: false, aborted: false, replaceBackend: true },
    { preparation: "backend-ready", revoked: false, aborted: false, replaceBackend: false },
    { preparation: "backend-ready", revoked: true, aborted: false, replaceBackend: false },
  ])(
    "preserves input at $preparation (caller revoked: $revoked, target aborted: $aborted, backend replaced: $replaceBackend)",
    async ({ preparation, revoked, aborted, replaceBackend }) => {
      const key = `agent:main:completed-steering-${preparation}-${revoked}-${aborted}-${replaceBackend}`;
      const holdBackend = preparation === "backend-ready";
      const read = holdBackend ? undefined : preparation === "fingerprint-1" ? 1 : 2;
      const run = createQueueTestRun({ prompt: "preserve this incoming turn", messageId: key });
      run.run.agentId = "main";
      run.run.sessionKey = key;
      let callerCurrent = true;
      run.operatorAuthority = operator(run, "incoming-user", () => {
        if (!callerCurrent) {
          throw new Error("incoming caller revoked");
        }
      });
      run.run.clientCaps = ["ui-commands"];
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: run.run.sessionId,
        resetTriggered: false,
      });
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
      await operation.bindToolAuthorityRouteAsync(run.run);
      run.run.clientCaps = ["ui-commands", "ui-tool-images"];
      run.run.gatewayUiCommandTarget = { connId: "new-tab", profileId: "incoming-user" };
      const injected = vi.fn(async () => {});
      const replacementInjected = vi.fn(async () => {});
      const attach = (queueMessage: () => Promise<void>) =>
        operation.attachBackend({
          kind: "embedded",
          terminalReplyExpectation: "result-required",
          cancel() {},
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
        });
      if (!holdBackend) {
        attach(injected);
      }
      operation.setPhase("running");
      const entered = createDeferred();
      const resume = createDeferred();
      if (holdBackend) {
        const waitForBackend = registryState.waitForReplyOperationBackend;
        vi.spyOn(registryState, "waitForReplyOperationBackend").mockImplementation((...args) => {
          const ready = waitForBackend(...args);
          entered.resolve();
          return ready;
        });
      }
      const delivered = createDeferred<FollowupRun>();
      const consumeFollowup = vi.fn(async (queued: FollowupRun) => delivered.resolve(queued));
      vi.spyOn(followupRunner, "createFollowupRunner").mockReturnValue(async (queued) => {
        // Follow-up admission owns execution ordering after a parked input settles.
        const admission = await admitReplyTurn({
          agentId: queued.run.agentId,
          sessionId: queued.run.sessionId,
          sessionKey: key,
          mailboxClaim: queued.controllerInput?.claim,
          kind: "queued_followup",
          resetTriggered: false,
        });
        expect(admission.status).toBe("owned");
        if (admission.status !== "owned") {
          return;
        }
        try {
          await consumeFollowup(queued);
        } finally {
          admission.operation.complete();
        }
      });
      const fingerprint = toolAuthority.prepareFollowupRunToolAuthorityFingerprint;
      let reads = 0;
      vi.spyOn(toolAuthority, "prepareFollowupRunToolAuthorityFingerprint").mockImplementation(
        async (...args) => {
          const result = await fingerprint(...args);
          if (++reads === read) {
            entered.resolve();
            await resume.promise;
          }
          return result;
        },
      );
      const resultState: ReplyOperationRunState = {};
      const typing = createMockTypingController();
      const incoming = steer(run, key, {
        opts: { runId: key, [REPLY_OPERATION_RUN_STATE]: resultState },
        typing,
      });
      try {
        await awaitGateBeforeSettlement(entered.promise, incoming, "Preparation was not held");
        if (replaceBackend) {
          attach(replacementInjected);
        } else if (aborted) {
          expect(operation.abortByUser()).toBe(true);
        } else {
          operation.complete();
        }
        callerCurrent = !revoked;
        resume.resolve();
        if (revoked) {
          await expect(incoming).rejects.toThrow("incoming caller revoked");
          expect(consumeFollowup).not.toHaveBeenCalled();
          expect(resultState.admission).toBeUndefined();
        } else {
          await expect(incoming).resolves.toBeUndefined();
          expect(replacementInjected).not.toHaveBeenCalled();
          expect(resultState.admission).toEqual({
            status: "accepted",
            mode: "followup",
            reason: "steering-unavailable",
          });
          if (aborted || replaceBackend) {
            expect(consumeFollowup).not.toHaveBeenCalled();
            operation.complete();
          }
          expect(await delivered.promise).toBe(run);
          expect(consumeFollowup).toHaveBeenCalledExactlyOnceWith(run);
        }
        expect(injected).not.toHaveBeenCalled();
        expect(getFollowupQueueDepth(key)).toBe(0);
        expect(typing.cleanup).toHaveBeenCalledOnce();
        expect(run.run.clientCaps).toEqual(["ui-commands", "ui-tool-images"]);
        expect(run.run.gatewayUiCommandTarget).toEqual({
          connId: "new-tab",
          profileId: "incoming-user",
        });
      } finally {
        resume.resolve();
        await incoming.catch(() => {});
        clearSessionQueues(
          [key],
          registryState.getSessionControllerEntryForOperation(operation).target,
        );
        operation.complete();
      }
    },
  );

  it.each([
    "automatic",
    "same-profile-caps",
    "same-profile-legacy-snapshot",
    "same-profile-exec-change",
    "same-profile-config-change",
    "same-profile-caps-narrower",
    "queued-followup",
    "cross-profile",
    "cross-profile-default",
    "cross-profile-pending",
    "collaborative-automatic",
    "collaborative-pinned-selection",
    "collaborative-locked-selection",
    "explicit-steer-same-requester",
    "explicit-steer-cross-profile",
    "policy-fallback",
    "explicit-redirect",
    "new-selection",
    "pinned-selection",
    "locked-selection",
    "changed-tools",
    "hook-route",
    "transport-alias",
  ] as const)("preserves admitted selection and authority: %s", async (scenario) => {
    const sameProfile = scenario.startsWith("same-profile");
    const collaborative = scenario.startsWith("collaborative-");
    const explicitSteer = scenario.startsWith("explicit-steer-");
    const crossProfile =
      collaborative ||
      scenario.startsWith("cross-profile") ||
      scenario === "explicit-steer-cross-profile";
    const key = `agent:main:fallback-steering-${scenario}`;
    const run = createQueueTestRun({ prompt: "use the new requirements", messageId: scenario });
    run.run.agentId = "main";
    run.run.sessionKey = key;
    run.run.sessionId = `fallback-${scenario}`;
    const modelConfig = {
      // A strict pin differs from the primary; a remembered default still permits fallback.
      primary: scenario.endsWith("pinned-selection") ? "openai/other-primary" : "openai/gpt-test",
      fallbacks: scenario === "policy-fallback" ? undefined : ["test-alias/test-model"],
    };
    run.run.config = {
      messages:
        scenario === "cross-profile-default"
          ? undefined
          : {
              queue: { allowCollaborativeSteering: collaborative || explicitSteer },
            },
      agents: { defaults: { model: modelConfig } },
    };
    const alias = {
      provider: "test-provider",
      ...(scenario === "transport-alias"
        ? { api: "openai-completions" as const, baseUrl: "https://example.invalid/v1" }
        : {}),
    };
    const plugins = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "test-provider",
          enabledByDefault: true,
          providers: ["test-provider"],
          modelCatalog: { aliases: { "test-alias": alias } },
        },
      ],
    });
    vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot").mockReturnValue(plugins);
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: run.run.sessionId,
      resetTriggered: false,
    });
    if (explicitSteer || collaborative) {
      run.run.conversationId = "shared-steering-chat";
    }
    if (crossProfile || explicitSteer || sameProfile) {
      run.operatorAuthority = operator(run, "alice");
      Object.assign(run.run, {
        senderId: "alice-sender",
        senderName: "Alice",
        senderIsOwner: true,
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
      });
    }
    const snapshot = sameProfile
      ? prepareReplyRunToolAuthority(run, undefined)
      : prepareReplyToolAuthority(run);
    await operation.bindToolAuthoritySnapshotAsync(
      scenario === "same-profile-legacy-snapshot"
        ? {
            ...snapshot,
            // Released projectors have no current host-private continuation preparer.
            projectAsync: (...args) => snapshot.projectAsync(...args),
          }
        : snapshot,
    );
    operation.setPhase("running");
    const delivered: string[] = [];
    const candidates: string[] = [];
    try {
      await runWithModelFallback({
        cfg: run.run.config,
        provider: run.run.provider,
        model: run.run.model,
        ...(scenario === "policy-fallback" ? { fallbacksOverride: ["test-alias/test-model"] } : {}),
        skipAuthProfileRuntime: true,
        run: async (provider, model, options) => {
          if (!options) {
            throw new Error("The fallback owner did not provide its selection provenance");
          }
          candidates.push(`${provider}/${model}`);
          bindReplyFallbackSteeringRoute({
            operation,
            provenance: options.modelRoutingProvenance,
            route: { provider, model },
            config: run.run.config,
            workspaceDir: run.run.workspaceDir,
          });
          if (provider === "openai") {
            if (scenario === "explicit-redirect") {
              throw new LiveSessionModelSwitchError({
                provider: "test-alias",
                model: "test-model",
              });
            }
            throw new FailoverError("Test primary is unavailable", {
              provider,
              model,
              reason: "model_not_found",
            });
          }
          const selected = normalizeProviderModelRef({
            provider,
            modelId: model,
            modelIdSource: "selected",
            cfg: run.run.config,
          });
          await operation.bindToolAuthorityRouteAsync({
            provider:
              scenario === "hook-route"
                ? "hook-provider"
                : scenario === "transport-alias"
                  ? "test-provider"
                  : selected.provider,
            model: selected.model,
          });
          operation.attachBackend({
            kind: "embedded",
            terminalReplyExpectation:
              explicitSteer || collaborative || sameProfile ? "required" : "result-required",
            supportsTranscriptCommitWait: true,
            cancel: vi.fn(),
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              claimPendingUserInputAnswer:
                scenario === "cross-profile-pending"
                  ? async (text: string, _options: unknown, assertCurrent: () => void) => {
                      assertCurrent();
                      delivered.push(text);
                      return true;
                    }
                  : undefined,
              queueMessage: async (text, _options, assertCurrent) => {
                if (scenario === "cross-profile-pending") {
                  throw new Error(
                    "A locked selection may only answer the pending fallback question",
                  );
                }
                assertCurrent();
                delivered.push(text);
              },
            },
          });
          return "active candidate";
        },
      });
      expect(candidates).toEqual(["openai/gpt-test", "test-alias/test-model"]);
      const requesterPrincipalKey = operation.requesterPrincipalKey;
      const toolAuthorityFingerprint = operation.toolAuthorityFingerprint;
      if (scenario === "new-selection") {
        run.run.provider = "test-provider";
        run.run.model = "test-model";
      } else if (scenario.endsWith("pinned-selection")) {
        run.run.hasSessionModelOverride = true;
        run.run.modelOverrideSource = "user";
      } else if (scenario.endsWith("locked-selection") || scenario === "cross-profile-pending") {
        run.run.modelSelectionLocked = true;
      } else if (scenario === "changed-tools") {
        run.toolsAllow = ["read"];
      }
      if (scenario === "same-profile-caps" || scenario === "same-profile-legacy-snapshot") {
        run.run.clientCaps = ["ui-commands", "ui-tool-images"];
      } else if (scenario === "same-profile-caps-narrower") {
        run.run.clientCaps = [];
      } else if (scenario === "same-profile-exec-change") {
        run.run.execOverrides = { security: "deny" };
      } else if (scenario === "same-profile-config-change") {
        run.run.config = { ...run.run.config, tools: { deny: ["exec"] } };
      }
      // This fixture starts at the authorized adapter boundary. Use its real
      // host intent producer, preserving explicit change versus resolved defaults.
      const steeringIntent = sameProfile
        ? resolveReplySteeringIntent({
            directives: parseInlineSessionDirectives(
              scenario === "same-profile-exec-change" ? "/exec security=deny" : run.prompt,
            ),
            resetTriggered: false,
          })
        : undefined;
      if (scenario === "same-profile-exec-change") {
        expect(steeringIntent).toEqual({ kind: "new-execution" });
      } else if (sameProfile) {
        expect(steeringIntent).toEqual({ kind: "continue-existing" });
      }
      const resultState: ReplyOperationRunState = {};
      const shouldSteer =
        scenario === "automatic" ||
        scenario === "same-profile-caps" ||
        scenario === "queued-followup" ||
        scenario === "collaborative-automatic" ||
        scenario === "policy-fallback" ||
        scenario === "explicit-steer-same-requester";
      if (scenario === "queued-followup") {
        const older = createQueueTestRun({ prompt: "run on the next turn", messageId: "older" });
        older.run.agentId = run.run.agentId;
        older.run.sessionId = run.run.sessionId;
        older.run.config = run.run.config;
        expect(
          enqueueFollowupRun(
            key,
            older,
            { mode: "followup", debounceMs: 0 },
            "none",
            undefined,
            false,
          ),
        ).toBe(true);
      }
      if (crossProfile) {
        run.operatorAuthority = operator(run, "bob");
        Object.assign(run.run, {
          senderId: "bob-sender",
          senderName: "Bob",
          gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
        });
      }
      const incomingCaps = structuredClone(run.run.clientCaps);
      const incomingTarget = structuredClone(run.run.gatewayUiCommandTarget);
      const incoming = steer(run, key, {
        steeringIntent,
        opts: { runId: scenario, [REPLY_OPERATION_RUN_STATE]: resultState },
        sessionCtx:
          explicitSteer || collaborative || sameProfile
            ? {
                Provider: "telegram",
                ChatId: sameProfile
                  ? (run.run.conversationId ?? undefined)
                  : "shared-steering-chat",
                SenderId: run.run.senderId,
                SenderName: run.run.senderName,
                GatewayClientCaps: run.run.clientCaps,
                GatewayUiCommandTarget: run.run.gatewayUiCommandTarget,
                // The command handler rewrites the prompt but retains the explicit turn facts.
                CommandTurn: explicitSteer
                  ? createCommandTurnContext("text", {
                      authorized: true,
                      commandName: "steer",
                      body: `/steer ${run.prompt}`,
                    })
                  : undefined,
              }
            : {},
      });
      await incoming;
      expect(resultState.admission).toEqual(
        crossProfile && run.run.config.messages?.queue?.allowCollaborativeSteering !== true
          ? {
              status: "accepted",
              mode: "followup",
              reason: "collaborative-steering-disabled",
            }
          : {
              status: "accepted",
              mode: shouldSteer ? "steer" : "followup",
              ...(shouldSteer
                ? {}
                : { reason: crossProfile ? "requester-mismatch" : "steering-unavailable" }),
            },
      );
      expect(delivered).toEqual(shouldSteer ? [run.prompt] : []);
      if (crossProfile && run.run.config.messages?.queue?.allowCollaborativeSteering !== true) {
        expect(getFollowupQueueDepth(key)).toBe(1);
      }
      expect(operation.requesterPrincipalKey).toBe(requesterPrincipalKey);
      expect(operation.toolAuthorityFingerprint).toBe(toolAuthorityFingerprint);
      expect(run.run.clientCaps).toEqual(incomingCaps);
      expect(run.run.gatewayUiCommandTarget).toEqual(incomingTarget);
      if (crossProfile) {
        const dispatch = await createPersonalToolScreenDispatcher(["alice", "bob"]);
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: key,
            personalToolParticipants: operation.personalToolParticipants,
          },
          async () => {
            const unselected = await dispatch();
            if (shouldSteer) {
              expect(unselected.broadcastToConnIds).not.toHaveBeenCalled();
              expect(unselected.respond).toHaveBeenCalledWith(
                false,
                undefined,
                expect.objectContaining({
                  code: "INVALID_REQUEST",
                  message: expect.stringContaining("Several people have steered this turn"),
                }),
              );
            }
            const unchanged = shouldSteer ? await dispatch("alice") : unselected;
            expect(unchanged.broadcastToConnIds).toHaveBeenCalledWith(
              "ui.command",
              expect.any(Object),
              new Set(["alice-tab"]),
            );
            const other = await dispatch("bob");
            if (shouldSteer) {
              // Personal tools retain their explicit participant selection after collaboration.
              expect(other.broadcastToConnIds).toHaveBeenCalledWith(
                "ui.command",
                expect.any(Object),
                new Set(["bob-tab"]),
              );
            } else {
              expect(other.broadcastToConnIds).not.toHaveBeenCalled();
            }
          },
        );
      }
    } finally {
      clearSessionQueues([key]);
      operation.complete();
    }
  });
});
