import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { normalizeProviderModelRef } from "../../agents/embedded-agent-runner/model.registry-resolution.js";
import { FailoverError } from "../../agents/failover-error.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as metadata from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { bindReplyFallbackSteeringRoute } from "./agent-runner-fallback-authority.js";
import { runReplyAgent } from "./agent-runner-run.js";
import * as followupRunner from "./followup-runner.js";
import { createPersonalToolScreenDispatcher } from "./personal-tool-turn.test-support.js";
import { getFollowupQueueDepth, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback } from "./queue/drain.js";
import { clearFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import * as registryState from "./reply-run-registry.state.js";
import * as toolAuthority from "./reply-tool-authority.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createMockTypingController } from "./test-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("ordinary steering into automatic model fallback", () => {
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
      run.operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "incoming-user",
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        modelPolicy: prepareOperatorModelPolicy({ cfg: run.run.config, policy: {} }),
        assertCurrent() {
          if (!callerCurrent) {
            throw new Error("incoming caller revoked");
          }
        },
      });
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: run.run.sessionId,
        resetTriggered: false,
      });
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
      operation.bindToolAuthorityRoute(run.run);
      const injected = vi.fn(async () => {});
      const replacementInjected = vi.fn(async () => {});
      if (!holdBackend) {
        operation.attachBackend({
          kind: "embedded",
          cancel() {},
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage: injected },
        });
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
      const consumeFollowup = vi.fn(async (queued: FollowupRun) => {
        delivered.resolve(queued);
      });
      vi.spyOn(followupRunner, "createFollowupRunner").mockReturnValue(async (queued) => {
        // Follow-up admission owns execution ordering after a parked input settles.
        const admission = await admitReplyTurn({
          agentId: queued.run.agentId,
          sessionId: queued.run.sessionId,
          sessionKey: key,
          kind: "queued_followup",
          resetTriggered: false,
        });
        expect(admission.status).toBe("owned");
        if (admission.status === "owned") {
          try {
            await consumeFollowup(queued);
          } finally {
            admission.operation.complete();
          }
        }
      });
      const fingerprint = toolAuthority.resolveFollowupRunToolAuthorityFingerprintAsync;
      let reads = 0;
      vi.spyOn(toolAuthority, "resolveFollowupRunToolAuthorityFingerprintAsync").mockImplementation(
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
      const incoming = runReplyAgent({
        commandBody: run.prompt,
        followupRun: run,
        opts: { runId: key, [REPLY_OPERATION_RUN_STATE]: resultState },
        queueKey: key,
        resolvedQueue: { mode: "steer", debounceMs: 0 },
        shouldSteer: true,
        shouldFollowup: false,
        isActive: true,
        typing,
        sessionCtx: {},
        sessionKey: key,
        defaultModel: "gpt-test",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "text_end",
        shouldInjectGroupIntro: false,
        typingMode: "never",
      });
      try {
        await awaitGateBeforeSettlement(entered.promise, incoming, "Preparation was not held");
        if (replaceBackend) {
          operation.attachBackend({
            kind: "embedded",
            cancel() {},
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              queueMessage: replacementInjected,
            },
          });
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
          expect(resultState.admission).toEqual({ status: "accepted", mode: "followup" });
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
      } finally {
        resume.resolve();
        await incoming.catch(() => {});
        clearFollowupQueue(key);
        clearFollowupDrainCallback(key);
        operation.complete();
      }
    },
  );

  it.each([
    "automatic",
    "cross-profile",
    "cross-profile-pending",
    "policy-fallback",
    "explicit-redirect",
    "new-selection",
    "pinned-selection",
    "locked-selection",
    "changed-tools",
    "hook-route",
    "transport-alias",
    "replaced-during-preparation",
  ] as const)("preserves admitted selection and authority: %s", async (scenario) => {
    const crossProfile = scenario === "cross-profile" || scenario === "cross-profile-pending";
    const key = `agent:main:fallback-steering-${scenario}`;
    const run = createQueueTestRun({ prompt: "use the new requirements", messageId: scenario });
    run.run.agentId = "main";
    run.run.sessionKey = key;
    run.run.config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-test",
            ...(scenario === "policy-fallback" ? {} : { fallbacks: ["test-alias/test-model"] }),
          },
        },
      },
    };
    const plugins = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "test-provider",
          enabledByDefault: true,
          providers: ["test-provider"],
          modelCatalog: {
            aliases: {
              "test-alias": {
                provider: "test-provider",
                ...(scenario === "transport-alias"
                  ? { api: "openai-completions" as const, baseUrl: "https://example.invalid/v1" }
                  : {}),
              },
            },
          },
        },
      ],
    });
    vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot").mockReturnValue(plugins);
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: run.run.sessionId,
      resetTriggered: false,
    });
    const modelPolicy = prepareOperatorModelPolicy({ cfg: run.run.config, policy: {} });
    const operator = (profileId: string) =>
      createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        modelPolicy,
        assertCurrent() {},
      });
    if (crossProfile) {
      run.operatorAuthority = operator("alice");
      Object.assign(run.run, {
        senderId: "alice-sender",
        senderName: "Alice",
        senderIsOwner: true,
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
      });
    }
    operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
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
          operation.bindToolAuthorityRoute({
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
            cancel: vi.fn(),
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              ...(scenario === "cross-profile-pending"
                ? {
                    claimPendingUserInputAnswer: async (
                      text: string,
                      _options: unknown,
                      assertCurrent: () => void,
                    ) => {
                      assertCurrent();
                      delivered.push(text);
                      return true;
                    },
                  }
                : {}),
              queueMessage: async (text, _options, assertCurrent) => {
                if (scenario === "cross-profile-pending") {
                  throw new Error(
                    "A locked selection may only answer the pending fallback question",
                  );
                }
                if (scenario === "replaced-during-preparation") {
                  await Promise.resolve();
                  operation.setAutomaticFallbackRoute(operation.automaticFallbackRoute);
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
      if (scenario === "new-selection") {
        run.run.provider = "test-provider";
        run.run.model = "test-model";
      } else if (scenario === "pinned-selection") {
        run.run.hasSessionModelOverride = true;
        run.run.modelOverrideSource = "user";
      } else if (scenario === "locked-selection" || scenario === "cross-profile-pending") {
        run.run.modelSelectionLocked = true;
      } else if (scenario === "changed-tools") {
        run.toolsAllow = ["read"];
      }
      const resultState: ReplyOperationRunState = {};
      const shouldSteer =
        scenario === "automatic" || scenario === "policy-fallback" || crossProfile;
      if (crossProfile) {
        run.operatorAuthority = operator("bob");
        Object.assign(run.run, {
          senderId: "bob-sender",
          senderName: "Bob",
          gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
        });
      }
      const incoming = runReplyAgent({
        commandBody: run.prompt,
        followupRun: run,
        opts: { runId: scenario, [REPLY_OPERATION_RUN_STATE]: resultState },
        queueKey: key,
        resolvedQueue: { mode: "steer", debounceMs: 0 },
        shouldSteer: true,
        shouldFollowup: false,
        isActive: true,
        typing: createMockTypingController(),
        sessionCtx: {},
        sessionKey: key,
        defaultModel: "gpt-test",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "text_end",
        shouldInjectGroupIntro: false,
        typingMode: "never",
      });
      if (scenario === "replaced-during-preparation") {
        await expect(incoming).rejects.toThrow(
          "Automatic model fallback changed during steering admission",
        );
      } else {
        await incoming;
        expect(resultState.admission).toEqual({
          status: "accepted",
          mode: shouldSteer ? "steer" : "followup",
        });
      }
      expect(delivered).toEqual(shouldSteer ? [run.prompt] : []);
      if (crossProfile) {
        const dispatch = await createPersonalToolScreenDispatcher(["alice", "bob"]);
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: key,
            personalToolParticipants: operation.personalToolParticipants,
          },
          async () => {
            const ambiguous = await dispatch();
            expect(ambiguous.respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                message: expect.stringMatching(/Alice \(user: alice\).*Bob \(user: bob\)/),
              }),
            );
            expect(ambiguous.broadcastToConnIds).not.toHaveBeenCalled();
            const selected = await dispatch("bob");
            expect(selected.broadcastToConnIds).toHaveBeenCalledWith(
              "ui.command",
              expect.any(Object),
              new Set(["bob-tab"]),
            );
          },
        );
      }
    } finally {
      clearFollowupQueue(key);
      clearFollowupDrainCallback(key);
      operation.complete();
    }
  });
});
