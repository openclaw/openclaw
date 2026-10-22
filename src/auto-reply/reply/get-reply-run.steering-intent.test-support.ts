import { describe, expect, it, vi } from "vitest";
import * as gatewayQuestion from "../../agents/harness/gateway-question.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import * as messageJoin from "../../sessions/session-controller.message-join.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { createSteerParams } from "./agent-runner-steer-adoption.test-support.js";
import { handleSteerCommand } from "./commands-steer.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { routeReplyDirectivesForTest } from "./get-reply-directives-routing.test-support.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import { runPreparedReply } from "./get-reply-run.js";
import { baseParams, createInboundTurn, createSessionTurn } from "./get-reply-run.test-support.js";
import { finalizeInboundContext } from "./inbound-context.js";
import * as modelSelection from "./model-selection.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { buildTestCtx } from "./test-ctx.js";

type Prepared = Parameters<typeof runPreparedReply>[0];

/** Keep actual command authorization, directive routing/application, and run construction. */
async function prepareIngress(body: string, authorized = true): Promise<Prepared> {
  const cfg: Prepared["cfg"] = {
    session: {},
    commands: { text: true },
    agents: { defaults: { thinkingDefault: "off", reasoningDefault: "off" } },
    tools: { elevated: { enabled: true, allowFrom: { webchat: ["owner-1"] } } },
  };
  const ctx = buildTestCtx({
    Body: body,
    RawBody: body,
    CommandBody: body,
    Provider: "webchat",
    Surface: "webchat",
    From: "owner-1",
    To: "thread-1",
    SenderId: "owner-1",
    SessionKey: "session-key",
    ChatType: "direct",
    CommandAuthorized: authorized,
    GatewayClientScopes: authorized ? ["operator.admin"] : ["operator.write"],
  });
  const sessionCtx = { ...ctx, BodyStripped: ctx.agentText };
  const sessionEntry = { sessionId: "session-1", updatedAt: 1, elevatedLevel: "off" as const };
  const params = baseParams({
    ctx,
    sessionCtx,
    cfg,
    agentCfg: cfg.agents?.defaults,
    sessionCfg: cfg.session,
    sessionEntry,
    sessionStore: { "session-key": sessionEntry },
    sessionId: sessionEntry.sessionId,
    isNewSession: false,
  });
  // This suite owns ingress/run construction, not model catalog I/O. The parser,
  // authorization owner, directive application, and final run producer stay real.
  const selected = createModelSelectionStateFixture({
    agentCfg: params.agentCfg,
    provider: params.provider,
    model: params.model,
  });
  const selection = vi.spyOn(modelSelection, "createModelSelectionState");
  selection.mockResolvedValueOnce(selected);
  vi.mocked(shouldUseReplyFastTestRuntime).mockReturnValueOnce(true);
  try {
    const routed = await resolveReplyDirectives({
      ...params,
      ctx,
      sessionCtx,
      sessionEntry,
      sessionStore: { "session-key": sessionEntry },
      sessionKey: "session-key",
      sessionScope: "per-sender",
      isGroup: false,
      triggerBodyNormalized: ctx.commandText,
      resetTriggered: false,
      commandAuthorized: authorized,
      defaultProvider: params.provider,
      defaultModel: params.model,
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      hasResolvedHeartbeatModelOverride: false,
    });
    expect(routed.kind).toBe("continue");
    if (routed.kind !== "continue") {
      throw new Error("Expected directive/prose input to continue to the run producer");
    }
    const levels = await routed.result.resolveModelLevels();
    return {
      ...params,
      ...routed.result,
      ...levels,
      defaultActivation: routed.result.defaultActivation,
      ctx,
      sessionCtx,
      // Directives can rewrite agent text. Capture conversation after that owner.
      conversation: prepareReplyConversation({ ctx: sessionCtx, sessionEntry }),
    };
  } finally {
    selection.mockRestore();
  }
}

export function registerSteeringIntentProducerCases(params: {
  runPrepared: (input: Partial<Prepared>) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => RunReplyAgentParams;
  activatePreparedRun: (key?: string) => ReplyOperation;
}): void {
  const { requireRunReplyAgentCall } = params;
  describe("steering intent from authenticated directive ingress", () => {
    it("preserves prompt bytes through authorized directive routing and preparation", async () => {
      const code =
        "Run  this:\r\n```python\r\n    if True:\r\n        print('a  b')\r\n\t\t# tabs  stay\r\n```";
      const body = `/think high\r\n${code}`;
      const prepared = baseParams({
        ctx: createInboundTurn(body, "slack", "direct"),
        sessionCtx: createSessionTurn(body, "slack", "direct"),
        isNewSession: false,
        commandAuthorized: true,
        allowTextCommands: true,
      });
      prepared.command = { ...prepared.command, isAuthorizedSender: true };
      const inbound = finalizeInboundContext({ ...prepared.ctx, CommandAuthorized: true });
      const routed = await routeReplyDirectivesForTest(inbound, {
        cfg: prepared.cfg,
        agentId: prepared.agentId,
        sessionKey: prepared.sessionKey,
      });
      prepared.directives = routed.directives;
      prepared.sessionCtx.agentText = routed.cleanedBody;
      await runPreparedReply(prepared);

      const expected = code.replaceAll("\r\n", "\n");
      const call = requireRunReplyAgentCall();
      expect(call.commandBody).toBe(expected);
      expect(call.followupRun.prompt).toBe(expected);
    });

    it.each([
      {
        name: "ordinary prose",
        body: "continue the task",
        authorized: true,
        kind: "continue-existing",
      },
      {
        name: "accepted exec policy",
        body: "/exec security=deny continue the task",
        authorized: true,
        kind: "new-execution",
      },
      {
        name: "accepted elevation off",
        body: "/elevated off continue the task",
        authorized: true,
        kind: "new-execution",
      },
      {
        name: "unauthorized exec text",
        body: "/exec security=deny continue the task",
        authorized: false,
        kind: "continue-existing",
      },
    ] as const)("retains $name through actual reply-run construction", async (testCase) => {
      const input = await prepareIngress(testCase.body, testCase.authorized);
      await params.runPrepared(input);
      const produced = params.requireRunReplyAgentCall();
      expect(produced.steeringIntent).toEqual({ kind: testCase.kind });
      expect(produced.followupRun.run.elevatedLevel).toBe("off");
      if (testCase.name === "accepted exec policy") {
        expect(produced.followupRun.run.execOverrides?.security).toBe("deny");
        expect(produced.followupRun.prompt).not.toContain("/exec");
      }
      if (testCase.name === "unauthorized exec text") {
        expect(input.command.isAuthorizedSender).toBe(false);
        expect(produced.followupRun.run.execOverrides?.security).toBeUndefined();
        expect(produced.followupRun.prompt).toContain(testCase.body);
      }
      // Both ordinary default off and explicitly requested off have the same
      // resolved value above; intent must survive the producer independently.
    });

    it.each(["/exec security=deny continue the task", "/elevated off continue the task"])(
      "keeps %s out of the question probe and active backend",
      async (body) => {
        const input = await prepareIngress(body);
        const claim = vi.spyOn(gatewayQuestion, "claimPendingAgentQuestionAnswerFromCaller");
        claim.mockImplementation(async () => {
          throw new Error("Execution settings reached the pending-question claim boundary");
        });
        const policy = vi.spyOn(messageJoin, "prepareReplyMessageJoin");
        policy.mockImplementation(async () => {
          throw new Error("Execution settings attempted to borrow incumbent policy");
        });
        const queueMessage = vi.fn(async () => {});
        const followup = vi.fn(async () => {});
        const touched = vi.fn(async () => {});
        const active = params.activatePreparedRun(input.sessionKey);
        active.attachBackend({
          kind: "embedded",
          cancel() {},
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
        });
        vi.mocked(runReplyAgent).mockImplementationOnce(async (produced) => {
          // Use the exact object emitted by executePreparedReplyRun. Never set
          // steeringIntent in a test or call the intent helper directly.
          await expect(runReplyQuestionInput(produced)).resolves.toEqual({ handled: false });
          try {
            await expect(
              runActiveReplySteer(
                createSteerParams(produced.queueKey, produced.followupRun, active, {
                  ...produced,
                  runFollowup: followup,
                  touchActiveSessionEntry: touched,
                }),
              ),
            ).resolves.toBe("handled");
            expect(getExistingFollowupQueue(produced.queueKey)?.items).toContain(
              produced.followupRun,
            );
            await expect(
              produced.followupRun.controllerInput?.injectionOrder.settled,
            ).resolves.toBe(false);
            expect(touched).toHaveBeenCalledOnce();
            expect(claim).not.toHaveBeenCalled();
            expect(policy).not.toHaveBeenCalled();
            expect(queueMessage).not.toHaveBeenCalled();
            expect(followup).not.toHaveBeenCalled();
          } finally {
            // The queue owns the input now; do not run a queued model turn here.
            clearFollowupQueue(produced.queueKey);
          }
          return undefined;
        });
        try {
          await params.runPrepared(input);
          expect(runReplyAgent).toHaveBeenCalledOnce();
        } finally {
          claim.mockRestore();
          policy.mockRestore();
        }
      },
    );

    it("keeps the actual /steer command rewrite as ordinary continuation", async () => {
      const body = "/steer continue the task";
      const input = await prepareIngress(body);
      const active = params.activatePreparedRun(input.sessionKey);
      active.attachBackend({
        kind: "embedded",
        cancel() {},
        messageInjectionV2: { version: 2, isAvailable: () => true, async queueMessage() {} },
      });
      const command = buildCommandTestParams(body, input.cfg);
      Object.assign(command, {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        ctx: input.sessionCtx,
        rootCtx: input.ctx,
        command: input.command,
      });
      const result = await handleSteerCommand(command, true);
      expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
      expect(input.sessionCtx.agentText).toBe("continue the task");
      await params.runPrepared({
        ...input,
        opts: { ...input.opts, queueModeOverride: "steer" },
        conversation: prepareReplyConversation({
          ctx: input.sessionCtx,
          sessionEntry: input.sessionEntry,
        }),
      });
      const produced = params.requireRunReplyAgentCall();
      expect(produced.steeringIntent).toEqual({ kind: "continue-existing" });
      expect(produced.resolvedQueue.mode).toBe("steer");
      expect(produced.followupRun.prompt).not.toContain("/steer");
    });
  });
}
