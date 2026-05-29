import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSnapshot } from "../../skills/types.js";
import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  clearFastTestEnv,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const { createCronPromptExecutor, executeCronRun } = await import("./run-executor.js");

const emptySkillsSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkills: [],
  version: 1,
};

function makeJob() {
  return {
    id: "source-delivery-guard",
    name: "Source Delivery Guard",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
  } as never;
}

function makeExecutor(overrides: Partial<Parameters<typeof createCronPromptExecutor>[0]>) {
  const resolvedDelivery = overrides.resolvedDelivery ?? {};

  return createCronPromptExecutor({
    cfg: {},
    cfgWithAgentDefaults: {},
    job: makeJob(),
    agentId: "default",
    agentDir: "/tmp/agent-dir",
    agentSessionKey: "cron:source-delivery-guard",
    runSessionKey: "cron:source-delivery-guard:run:test-session-id",
    workspaceDir: "/tmp/workspace",
    resolvedVerboseLevel: "off",
    thinkLevel: undefined,
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
    skillsSnapshot: emptySkillsSnapshot,
    agentPayload: null,
    useSubagentFallbacks: false,
    liveSelection: {
      provider: "openai",
      model: "gpt-5.4",
    },
    cronSession: makeCronSession() as MutableCronSession,
    abortReason: () => "aborted",
    ...overrides,
    resolvedDelivery,
  });
}

function getEmbeddedRunArg(): Record<string, unknown> {
  const call = runEmbeddedAgentMock.mock.calls[0];
  if (!call) {
    throw new Error("expected runEmbeddedAgent to be called");
  }
  return call[0] as Record<string, unknown>;
}

describe("createCronPromptExecutor sourceDelivery guard", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    previousFastTestEnv = clearFastTestEnv();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("reconstructs a safe delivery plan when sourceDelivery is undefined", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: undefined,
      resolvedDelivery: {
        channel: "messagechat",
        accountId: "acct-1",
        threadId: "thread-99",
      },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(true);
    expect(args.agentAccountId).toBe("acct-1");
    expect(args.messageThreadId).toBe("thread-99");
  });

  it("uses resolvedDelivery channel/to for legacy callers without sourceDelivery", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: undefined,
      resolvedDelivery: { channel: "topicchat", to: "room#42" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.messageChannel).toBe("topicchat");
    expect(args.messageTo).toBe("room#42");
  });

  it("reads legacy toolPolicy/sourceReplyDeliveryMode from stale announce caller", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: undefined,
      resolvedDelivery: { channel: "messagechat", to: "123" },
      toolPolicy: {
        disableMessageTool: false,
        forceMessageTool: true,
        requireExplicitMessageTarget: false,
      },
      sourceReplyDeliveryMode: "message_tool_only",
    } as never);

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(true);
  });

  it("reads legacy toolPolicy from stale webhook caller with message tool disabled", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: undefined,
      resolvedDelivery: { channel: "messagechat", to: "456" },
      toolPolicy: {
        disableMessageTool: true,
        forceMessageTool: false,
        requireExplicitMessageTarget: false,
      },
      sourceReplyDeliveryMode: undefined,
    } as never);

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(true);
    expect(args.forceMessageTool).toBe(false);
  });

  it("passes requireExplicitMessageTarget from legacy toolPolicy in createCronPromptExecutor", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: undefined,
      resolvedDelivery: { channel: "messagechat", to: "789" },
      toolPolicy: {
        disableMessageTool: false,
        forceMessageTool: true,
        requireExplicitMessageTarget: true,
      },
      sourceReplyDeliveryMode: "message_tool_only",
    } as never);

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.requireExplicitMessageTarget).toBe(true);
  });

  it("still works with a valid sourceDelivery", async () => {
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

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(true);
    expect(args.messageChannel).toBe("messagechat");
  });
});

function makeExecuteCronRunParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: {},
    cfgWithAgentDefaults: {},
    job: makeJob(),
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
    cronSession: makeCronSession() as MutableCronSession,
    commandBody: "run a task",
    persistSessionEntry: vi.fn().mockResolvedValue(undefined),
    abortReason: () => "aborted",
    isAborted: () => false,
    thinkLevel: undefined,
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
    resolvedDelivery: {},
    sourceDelivery: undefined,
    ...overrides,
  } as never;
}

describe("executeCronRun sourceDelivery guard", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    previousFastTestEnv = clearFastTestEnv();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("preserves legacy sourceReplyDeliveryMode: message_tool_only through executeCronRun", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        resolvedDelivery: { channel: "messagechat", to: "123" },
        toolPolicy: {
          disableMessageTool: false,
          forceMessageTool: true,
          requireExplicitMessageTarget: false,
        },
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(true);
  });

  it("defaults to sourceReplyDeliveryMode undefined when legacy mode is absent", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        resolvedDelivery: { channel: "messagechat", to: "456" },
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("passes requireExplicitMessageTarget through executeCronRun fallback", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        resolvedDelivery: { channel: "messagechat", to: "789" },
        toolPolicy: {
          disableMessageTool: false,
          forceMessageTool: true,
          requireExplicitMessageTarget: true,
        },
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.requireExplicitMessageTarget).toBe(true);
    expect(args.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("passes requireExplicitMessageTarget=false by default when legacy toolPolicy omits it", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        resolvedDelivery: { channel: "messagechat", to: "101" },
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.requireExplicitMessageTarget).toBe(false);
  });

  it("reads legacy toolPolicy with message tool disabled through executeCronRun", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        resolvedDelivery: { channel: "messagechat", to: "202" },
        toolPolicy: {
          disableMessageTool: true,
          forceMessageTool: false,
          requireExplicitMessageTarget: false,
        },
        sourceReplyDeliveryMode: undefined,
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(true);
    expect(args.forceMessageTool).toBe(false);
  });
});
