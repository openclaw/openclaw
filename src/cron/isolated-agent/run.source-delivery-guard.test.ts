import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { CronJob } from "../types.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  clearFastTestEnv,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
  resolveCronDeliveryPlanMock,
} from "./run.test-harness.js";

const actualDeliveryPlanModule =
  await vi.importActual<typeof import("../delivery-plan.js")>("../delivery-plan.js");
const { executeCronRun } = await import("./run-executor.js");
const { resolveCronSourceDeliveryPlan } = await import("./source-delivery-plan.js");

const emptySkillsSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkills: [],
  version: 1,
};

function makeJob(
  params: {
    delivery?: CronJob["delivery"];
    omitDelivery?: boolean;
    sessionTarget?: CronJob["sessionTarget"];
  } = {},
): CronJob {
  return {
    id: "source-delivery-guard",
    name: "Source Delivery Guard",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: params.sessionTarget ?? "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...(params.omitDelivery ? {} : { delivery: params.delivery ?? { mode: "none" } }),
    state: {},
  } as CronJob;
}

function makeExecutor(overrides: Record<string, unknown>) {
  return {
    runPrompt: async (commandBody: string) =>
      await executeCronRun(
        makeExecuteCronRunParams({
          ...overrides,
          commandBody,
        }),
      ),
  };
}

function getEmbeddedRunArg(): Record<string, unknown> {
  const call = runEmbeddedAgentMock.mock.calls[0];
  if (!call) {
    throw new Error("expected runEmbeddedAgent to be called");
  }
  return call[0] as Record<string, unknown>;
}

describe("executeCronRun sourceDelivery mapping", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronDeliveryPlanMock.mockImplementation(
      actualDeliveryPlanModule.resolveCronDeliveryPlan,
    );
    previousFastTestEnv = clearFastTestEnv();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it('uses prepared delivery.mode "none" with messageToolForced false and owner none', async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "none" } }),
      deliveryRequested: false,
      resolvedDelivery: {
        channel: "messagechat",
        accountId: "acct-1",
        threadId: "thread-99",
      },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.runId).toBe("source-delivery-run");
    expect(args.sessionId).toBe("test-session-id");
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.terminalReplyExpectation).toBe("optional");
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.agentAccountId).toBe("acct-1");
    expect(args.messageThreadId).toBe("thread-99");
  });

  it('uses prepared delivery.mode "announce" with direct fallback semantics', async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "123" } }),
      deliveryRequested: true,
      resolvedDelivery: { ok: true, channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.terminalReplyExpectation).toBe("optional");
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.messageChannel).toBe("messagechat");
    expect(args.messageTo).toBe("123");
  });

  it('uses prepared delivery.mode "webhook" with message tool disabled', async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "webhook" } }),
      deliveryRequested: false,
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.terminalReplyExpectation).toBe("optional");
    expect(args.disableMessageTool).toBe(true);
    expect(args.forceMessageTool).toBe(false);
    expect(args.messageChannel).toBe("messagechat");
  });

  it("uses prepared announce behavior when isolated agentTurn has no delivery config", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ omitDelivery: true }),
      deliveryRequested: true,
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.terminalReplyExpectation).toBe("optional");
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.messageChannel).toBe("messagechat");
  });

  it("uses the prepared plan instead of stale legacy delivery fields", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "123" } }),
      resolvedDelivery: { channel: "messagechat", to: "123" },
      messageChannel: "legacychat",
      toolPolicy: {
        disableMessageTool: true,
        forceMessageTool: true,
        requireExplicitMessageTarget: true,
      },
      sourceReplyDeliveryMode: "message_tool_only",
    } as never);

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.messageChannel).toBe("messagechat");
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.requireExplicitMessageTarget).toBe(true);
  });

  it("does not require a terminal reply when announce delivery did not resolve", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      job: makeJob({ delivery: { mode: "announce", channel: "messagechat", to: "123" } }),
      deliveryRequested: true,
      resolvedDelivery: { ok: false, channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(getEmbeddedRunArg().terminalReplyExpectation).toBe("optional");
  });

  it("preserves an explicitly prepared message-tool source delivery", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: createSourceDeliveryPlan({
        owner: "message_tool_then_direct_fallback",
        reason: "cron_announce",
        target: { channel: "messagechat", to: "123" },
        messageToolEnabled: true,
        messageToolForced: true,
        directFallback: true,
      }),
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("send a message");

    expect(resolveCronDeliveryPlanMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(true);
    expect(args.messageChannel).toBe("messagechat");
    const finalizePromptForResolvedTools = args.finalizePromptForResolvedTools;
    expect(finalizePromptForResolvedTools).toBeTypeOf("function");
    expect(() =>
      (
        finalizePromptForResolvedTools as (params: {
          prompt: string;
          messageToolAvailable: boolean;
        }) => string
      )({
        prompt: "send a message",
        messageToolAvailable: false,
      }),
    ).toThrow("Cron source delivery requires the message tool");
  });

  it("forwards an explicit OpenClaw runtime override to cron execution", async () => {
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession() as unknown as MutableCronSession;
    cronSession.sessionEntry.agentRuntimeOverride = "openclaw";
    cronSession.sessionEntry.agentHarnessId = "codex";
    const executor = makeExecutor({
      cfgWithAgentDefaults: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
      liveSelection: { provider: "openai", model: "gpt-5.6-luna" },
      cronSession,
      immutableThinkLevel: "ultra",
    });

    await executor.runPrompt("run an Ultra task");

    expect(getEmbeddedRunArg()).toEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        thinkLevel: "ultra",
        agentHarnessRuntimeOverride: "openclaw",
      }),
    );
    expect(getEmbeddedRunArg()).not.toHaveProperty("agentHarnessId");
  });
});

function makeExecuteCronRunParams(overrides: Record<string, unknown> = {}) {
  const job = (overrides.job ?? makeJob()) as CronJob;
  const resolvedDelivery = {
    ok: true,
    ...(overrides.resolvedDelivery as
      | Partial<Parameters<typeof resolveCronSourceDeliveryPlan>[0]["resolvedDelivery"]>
      | undefined),
  };

  return {
    runId: "source-delivery-run",
    cfg: {},
    cfgWithAgentDefaults: {},
    job,
    agentId: "default",
    agentDir: "/tmp/agent-dir",
    agentSessionKey: "cron:source-delivery-guard",
    runSessionKey: "cron:source-delivery-guard:run:test-session-id",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: emptySkillsSnapshot,
    agentPayload: null,
    useSubagentFallbacks: false,
    agentVerboseDefault: undefined,
    liveSelection: {
      provider: "openai",
      model: "gpt-5.4",
    },
    cronSession: makeCronSession() as unknown as MutableCronSession,
    commandBody: "run a task",
    persistSessionEntry: vi.fn().mockResolvedValue(undefined),
    lifecycle: createAgentLifecycleTerminalBackstop({
      runId: "source-delivery-run",
      sessionKey: "cron:source-delivery-guard:run:test-session-id",
      getLifecycleGeneration: getAgentEventLifecycleGeneration,
      resolveTerminationFields: () => ({}),
    }),
    abortReason: () => "aborted",
    isAborted: () => false,
    immutableThinkLevel: undefined,
    loadThinkingCatalog: async () => [],
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
    sourceDelivery: resolveCronSourceDeliveryPlan({
      deliveryPlan: actualDeliveryPlanModule.resolveCronDeliveryPlan(job),
      resolvedDelivery,
    }),
    ...overrides,
    resolvedDelivery,
  } as never;
}
