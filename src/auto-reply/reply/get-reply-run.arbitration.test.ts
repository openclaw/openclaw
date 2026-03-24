import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { createMockTypingController } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  runReplyAgent: vi.fn(async () => undefined as ReplyPayload | ReplyPayload[] | undefined),
  routeReply: vi.fn(async () => ({ ok: true })),
  resolveQueueModelArbitrator: vi.fn(),
  arbitrateQueueDecision: vi.fn(),
  getQueueSize: vi.fn(),
  clearCommandLane: vi.fn(),
  isEmbeddedPiRunActive: vi.fn(),
  isEmbeddedPiRunStreaming: vi.fn(),
  resolveEmbeddedSessionLane: vi.fn(),
  abortEmbeddedPiRun: vi.fn(),
  ensureSkillSnapshot: vi.fn(),
  prependSystemEvents: vi.fn(),
  resolveSessionAuthProfileOverride: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("./agent-runner.js", () => ({ runReplyAgent: mocks.runReplyAgent }));
vi.mock("./route-reply.js", () => ({
  routeReply: mocks.routeReply,
}));
vi.mock("./queue/model-arbitrator.js", () => ({
  resolveQueueModelArbitrator: mocks.resolveQueueModelArbitrator,
}));
vi.mock("./queue/arbitration.js", () => ({
  arbitrateQueueDecision: mocks.arbitrateQueueDecision,
}));
vi.mock("../../process/command-queue.js", () => ({
  getQueueSize: mocks.getQueueSize,
  clearCommandLane: mocks.clearCommandLane,
}));
vi.mock("../../agents/pi-embedded.js", () => ({
  isEmbeddedPiRunActive: mocks.isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming: mocks.isEmbeddedPiRunStreaming,
  resolveEmbeddedSessionLane: mocks.resolveEmbeddedSessionLane,
  abortEmbeddedPiRun: mocks.abortEmbeddedPiRun,
}));
vi.mock("./session-updates.js", () => ({
  ensureSkillSnapshot: mocks.ensureSkillSnapshot,
  prependSystemEvents: mocks.prependSystemEvents,
  drainFormattedSystemEvents: vi.fn(async () => ""),
  buildQueuedSystemPrompt: vi.fn(),
}));
vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: mocks.resolveSessionAuthProfileOverride,
}));
vi.mock("../../logger.js", () => ({ logInfo: mocks.logInfo }));

const { runPreparedReply } = await import("./get-reply-run.js");

function createParams() {
  const typing = createMockTypingController();
  const onLatencyStage = vi.fn();
  const body = "我补充下：从基模的大小尺寸和是否需要微调上说";
  return {
    ctx: {
      Body: body,
      CommandBody: body,
      RawBody: body,
      ChatType: "direct",
    } as MsgContext,
    sessionCtx: {
      Body: body,
      BodyStripped: body,
      Provider: "slack",
      To: "channel:C123",
      AccountId: "acc-1",
      ChatType: "direct",
      MessageSid: "msg-1",
    } as TemplateContext,
    cfg: { messages: { queue: {} } },
    agentId: "main",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      abortKey: "abort:1",
      channel: "slack",
      from: "user:1",
      to: "channel:C123",
      senderIsOwner: false,
      ownerList: [],
      isAuthorizedSender: true,
      rawBodyNormalized: body,
      commandBodyNormalized: body,
    },
    commandSource: "slack",
    allowTextCommands: true,
    directives: {
      cleaned: body,
      hasThinkDirective: false,
      thinkLevel: undefined,
      rawThinkLevel: undefined,
      hasVerboseDirective: false,
      verboseLevel: undefined,
      rawVerboseLevel: undefined,
      hasReasoningDirective: false,
      reasoningLevel: undefined,
      rawReasoningLevel: undefined,
      hasElevatedDirective: false,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      hasExecDirective: false,
      execHost: undefined,
      execSecurity: undefined,
      execAsk: undefined,
      execNode: undefined,
      rawExecHost: undefined,
      rawExecSecurity: undefined,
      rawExecAsk: undefined,
      rawExecNode: undefined,
      hasExecOptions: false,
      invalidExecHost: false,
      invalidExecSecurity: false,
      invalidExecAsk: false,
      invalidExecNode: false,
      hasStatusDirective: false,
      hasFastDirective: false,
      fastMode: undefined,
      rawFastMode: undefined,
      hasModelDirective: false,
      rawModelDirective: undefined,
      rawModelProfile: undefined,
      hasQueueDirective: false,
      queueMode: undefined,
      queueReset: false,
      rawQueueMode: undefined,
      debounceMs: undefined,
      cap: undefined,
      dropPolicy: undefined,
      rawDebounce: undefined,
      rawCap: undefined,
      rawDrop: undefined,
      hasQueueOptions: false,
    },
    defaultActivation: "mention" as const,
    resolvedThinkLevel: "low" as const,
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolvedElevatedLevel: "off" as const,
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "text_end" as const,
    modelState: {
      provider: "anthropic",
      model: "claude-opus",
      allowedModelKeys: new Set<string>(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      resolveDefaultThinkingLevel: vi.fn(async () => "low" as const),
      resolveDefaultReasoningLevel: vi.fn(async () => "off" as const),
      needsModelCatalog: false,
    },
    provider: "anthropic",
    model: "claude-opus",
    typing,
    opts: { onStatusReply: vi.fn(async () => true), onLatencyStage },
    defaultProvider: "anthropic",
    defaultModel: "claude-opus",
    timeoutMs: 30_000,
    isNewSession: false,
    resetTriggered: false,
    systemSent: true,
    sessionEntry: { sessionId: "sess-1", updatedAt: Date.now(), systemSent: true },
    sessionStore: {},
    sessionKey: "agent:main:thread-1",
    sessionId: "sess-1",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    __test: { onLatencyStage },
  };
}

describe("runPreparedReply queue arbitration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeReply.mockResolvedValue({ ok: true });
    mocks.ensureSkillSnapshot.mockResolvedValue({
      sessionEntry: undefined,
      skillsSnapshot: undefined,
      systemSent: true,
    });
    mocks.prependSystemEvents.mockImplementation(async ({ prefixedBodyBase }) => prefixedBodyBase);
    mocks.resolveSessionAuthProfileOverride.mockResolvedValue(undefined);
    mocks.resolveEmbeddedSessionLane.mockReturnValue("lane:agent:main:thread-1");
    mocks.getQueueSize.mockReturnValue(0);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunStreaming.mockReturnValue(true);
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.clearCommandLane.mockReturnValue(2);
  });

  it("passes steer decisions from arbitration into runReplyAgent", async () => {
    const arbitrator = vi.fn(async () => "steer");
    mocks.resolveQueueModelArbitrator.mockReturnValue(arbitrator);
    mocks.arbitrateQueueDecision.mockResolvedValue({
      ruleResult: "defer",
      modelResult: "steer",
      modelLatencyMs: 12,
      finalDecision: "steer",
    });

    await runPreparedReply(createParams());

    expect(mocks.arbitrateQueueDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: false,
        body: "我补充下：从基模的大小尺寸和是否需要微调上说",
        modelArbitrator: arbitrator,
      }),
    );
    expect(mocks.runReplyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedQueue: expect.objectContaining({ mode: "steer" }),
        shouldSteer: true,
        shouldFollowup: false,
      }),
    );
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("clears backlog and aborts the active run for interrupt decisions", async () => {
    mocks.getQueueSize.mockReturnValue(3);
    mocks.resolveQueueModelArbitrator.mockReturnValue(undefined);
    mocks.arbitrateQueueDecision.mockResolvedValue({
      ruleResult: "interrupt",
      finalDecision: "interrupt",
    });

    await runPreparedReply(createParams());

    expect(mocks.clearCommandLane).toHaveBeenCalledWith("lane:agent:main:thread-1");
    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("sess-1");
  });

  it("logs arbitration details for active sessions without explicit queue overrides", async () => {
    const arbitrator = vi.fn(async () => "steer");
    mocks.resolveQueueModelArbitrator.mockReturnValue(arbitrator);
    mocks.arbitrateQueueDecision.mockResolvedValue({
      ruleResult: "defer",
      modelResult: undefined,
      modelLatencyMs: 17,
      finalDecision: "collect",
    });

    await runPreparedReply(createParams());

    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.stringContaining(
        'reply: Queue arbitration: session=agent:main:thread-1 active=true streaming=true lane=0 configured=collect rule_result=defer model_result=no-decision model_latency_ms=17 final_decision=collect body="我补充下：从基模的大小尺寸和是否需要微调上说"',
      ),
    );
  });

  it("passes lane size through to the reply runner", async () => {
    mocks.getQueueSize.mockReturnValue(4);
    mocks.resolveQueueModelArbitrator.mockReturnValue(undefined);
    mocks.arbitrateQueueDecision.mockResolvedValue({
      ruleResult: "defer",
      finalDecision: "collect",
    });
    await runPreparedReply(createParams());

    expect(mocks.runReplyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        laneSize: 4,
      }),
    );
  });

  it("emits a queue_arbitrated latency stage with supervisor metadata", async () => {
    mocks.resolveQueueModelArbitrator.mockReturnValue(undefined);
    mocks.arbitrateQueueDecision.mockResolvedValue({
      ruleResult: "defer",
      finalDecision: "collect",
    });
    const params = createParams();

    await runPreparedReply(params);

    expect(params.__test.onLatencyStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "queue_arbitrated",
        queueModeConfigured: "collect",
        queueModeFinal: "collect",
        supervisorAction: "append",
        supervisorRelation: "same_task_supplement",
      }),
    );
  });
});
