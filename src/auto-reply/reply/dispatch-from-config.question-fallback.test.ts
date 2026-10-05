import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { claimEmbeddedPendingUserInputAnswer } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { EmbeddedQuestionBroker } from "../../infra/embedded-question-broker.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { createDispatcher, sessionStoreMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import {
  prepareReplyToolAuthority,
  resolveInboundReplyToolAuthorityOverlay,
} from "./reply-tool-authority.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  clearAgentHarnesses();
});

function createQuestionDispatch(name: string) {
  const key = `agent:main:discord:direct:question-${name}`;
  const sessionId = `question-${name}`;
  sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  operation.setPhase("running");
  return { operation, cancel: vi.fn() };
}

describe("early pending fallback question admission", () => {
  it.each(["accepted", "altered-tools", "cross-profile-disabled"] as const)(
    "keeps the early production pending fallback claim boundary for %s",
    async (outcome) => {
      const fixture = createQuestionDispatch(`early-fallback-${outcome}`);
      const cfg = {
        ...automaticDirectReplyConfig,
        agents: { defaults: { model: { primary: "openai/gpt-test" } } },
      };
      const modelPolicy = prepareOperatorModelPolicy({ cfg, policy: {} });
      const operator = (profileId: string) =>
        createAdmittedRunOperatorAuthority({
          profileId,
          scopes: ["operator.read", "operator.write"],
          gatewayAccessGrant: null,
          modelPolicy,
          assertCurrent() {},
        });
      const ctxFor = (profileId: string) =>
        buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          From: "user:question-fixture",
          To: "channel:question-fixture",
          SessionKey: fixture.operation.key,
          MessageSid: `early-fallback-answer-${outcome}`,
          Body: "Continue",
          RawBody: "Continue",
          BodyForAgent: "Continue",
          BodyForCommands: "Continue",
          CommandBody: "Continue",
          CommandAuthorized: true,
          SenderId: `${profileId}-sender`,
          SenderName: profileId,
          GatewayClientCaps: ["ui-commands"],
          GatewayUiCommandTarget: { connId: `${profileId}-tab`, profileId },
        });
      const creatorCtx = ctxFor("alice");
      const creator = operator("alice");
      const creatorAuthorization = resolveCommandAuthorization({
        ctx: creatorCtx,
        cfg,
        commandAuthorized: creatorCtx.CommandAuthorized,
      });
      const creatorOverlay = resolveInboundReplyToolAuthorityOverlay({
        ctx: creatorCtx,
        sessionEntry: sessionStoreMocks.currentEntry,
        senderIsOwner: creatorAuthorization.senderIsOwner,
        operatorAuthority: creator,
        disableTools: false,
      });
      const { operatorAuthority, originatingChannel, toolsAllow, disableTools, ...creatorFacts } =
        creatorOverlay;
      const run = createQueueTestRun({ prompt: "Continue", originatingChannel });
      Object.assign(run, { operatorAuthority, toolsAllow, disableTools });
      Object.assign(run.run, creatorFacts, {
        agentId: "main",
        config: cfg,
        sessionKey: fixture.operation.key,
        sessionId: fixture.operation.sessionId,
      });
      fixture.operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
      fixture.operation.bindToolAuthorityRoute({ provider: "openai", model: "gpt-fallback" });
      fixture.operation.setAutomaticFallbackRoute({ provider: "openai", model: "gpt-fallback" });
      const creatorFingerprint = fixture.operation.toolAuthorityFingerprint!;
      const bob = operator("bob");
      const ctx = ctxFor("bob");
      const bobAuthorization = resolveCommandAuthorization({
        ctx,
        cfg,
        commandAuthorized: ctx.CommandAuthorized,
      });
      const incomingTools = outcome === "altered-tools" ? ["read"] : undefined;
      const caller = resolveInboundReplyToolAuthorityOverlay({
        ctx,
        sessionEntry: sessionStoreMocks.currentEntry,
        senderIsOwner: bobAuthorization.senderIsOwner,
        operatorAuthority: bob,
        toolsAllow: incomingTools,
        disableTools: false,
      });
      const projectedFingerprint = fixture.operation.projectToolAuthorityFingerprint(caller);
      if (outcome === "altered-tools") {
        expect(projectedFingerprint).not.toBe(creatorFingerprint);
      } else {
        expect(projectedFingerprint).toBe(creatorFingerprint);
      }
      const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
      const questionId = `ask_early_fallback_${outcome}`;
      const questions = [{ id: "answer", header: "Answer", question: "Continue?", options: [] }];
      broker.request({
        id: questionId,
        sessionKey: fixture.operation.key,
        questions: questions.map(({ id, ...question }) => ({ ...question, questionId: id })),
      });
      const resolved = vi.fn();
      const gatewayCall: AgentQuestionDispatcher = {
        version: 2,
        call: async (request) => {
          if (request.authority.kind === "source-bound") {
            request.authority.assertCurrent();
          }
          if (request.method === "question.resolve") {
            resolved();
          }
          return broker.call(request.method, request.params);
        },
      };
      const question = withAgentQuestionAnswerAuthority(
        createAgentQuestionAnswerAuthority({
          sessionKey: fixture.operation.key,
          fingerprint: creatorFingerprint,
          project: (overlay) =>
            fixture.operation.projectToolAuthorityFingerprint(overlay) ?? "missing-owner",
          assertActive() {},
        }),
        () =>
          registerPendingAgentQuestion({
            sessionKey: fixture.operation.key,
            questionId,
            questions,
            gatewayCall,
            answer: broker.waitAnswer({ id: questionId, includeResolutionId: true }),
          }),
      );
      question.attachRegistration(Promise.resolve());
      const claim = vi.fn(
        async (
          text: string,
          options: Parameters<typeof claimEmbeddedPendingUserInputAnswer>[1],
          assertCurrent: () => void,
        ) =>
          claimEmbeddedPendingUserInputAnswer(
            text,
            options,
            fixture.operation.key,
            () => true,
            { kind: "source-bound", assertCurrent },
            creatorFingerprint,
          ),
      );
      fixture.operation.attachBackend({
        kind: "embedded",
        cancel: fixture.cancel,
        ...(outcome === "cross-profile-disabled" ? { supportsCrossProfileSteering: false } : {}),
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage: vi.fn(async () => {
            throw new Error("must not queue an answer");
          }),
          claimPendingUserInputAnswer: claim,
        },
      });
      const onAdopted = vi.fn(async () => {});
      const replyResolver = vi.fn(async () => ({ text: "must not start another turn" }));
      const dispatcher = createDispatcher();
      try {
        await dispatchReplyFromConfig({
          ctx,
          cfg,
          dispatcher,
          replyOptions: {
            operatorAuthority: bob,
            toolsAllow: incomingTools,
            turnAdoptionLifecycle: { onAdopted },
          },
          replyResolver,
        });
        expect(replyResolver).not.toHaveBeenCalled();
        expect(fixture.cancel).not.toHaveBeenCalled();
        if (outcome === "accepted") {
          expect(resolved).toHaveBeenCalledOnce();
          expect(onAdopted).toHaveBeenCalledOnce();
          expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
          expect(broker.get({ id: questionId }).question).toMatchObject({ status: "answered" });
          expect(fixture.operation.personalToolParticipants?.resolve("bob")).toMatchObject({
            profileId: "bob",
            name: "bob",
            gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
          });
          expect(claim).toHaveBeenCalledWith(
            "Continue",
            expect.objectContaining({
              toolAuthorityFingerprint: creatorFingerprint,
            }),
            expect.any(Function),
            "source-bound",
            expect.any(Function),
          );
        } else {
          expect(resolved).not.toHaveBeenCalled();
          expect(onAdopted).not.toHaveBeenCalled();
          expect(broker.get({ id: questionId }).question).toMatchObject({ status: "pending" });
          expect(broker.get({ id: questionId }).question.answers).toBeUndefined();
          expect(() => fixture.operation.personalToolParticipants?.resolve("bob")).toThrow(
            "User is not a participant",
          );
          expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
            expect.objectContaining({
              text: expect.stringContaining("The answer was not sent"),
              isError: true,
            }),
          );
        }
      } finally {
        question.dispose();
        broker.stop();
        fixture.operation.complete();
      }
    },
  );
});
