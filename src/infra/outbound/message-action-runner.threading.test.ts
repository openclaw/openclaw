import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installMessageActionRunnerTestRegistry,
  resetMessageActionRunnerTestRegistry,
  slackConfig,
  telegramConfig,
} from "./message-action-runner.test-helpers.js";

const mocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executeSendAction: mocks.executeSendAction,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

import { runMessageAction } from "./message-action-runner.js";

const telegramConfigAllowWithinProvider = {
  ...telegramConfig,
  tools: {
    message: {
      crossContext: {
        allowWithinProvider: true,
      },
    },
  },
} as typeof telegramConfig;

async function runThreadingAction(params: {
  cfg: typeof slackConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) {
  await runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    agentId: "main",
  });
  return mocks.executeSendAction.mock.calls[0]?.[0] as {
    threadId?: string;
    replyToId?: string;
    ctx?: { agentId?: string; mirror?: { sessionKey?: string }; params?: Record<string, unknown> };
  };
}

function mockHandledSendAction() {
  mocks.executeSendAction.mockResolvedValue({
    handledBy: "plugin",
    payload: {},
  });
}

const defaultTelegramToolContext = {
  currentChannelId: "telegram:123",
  currentThreadTs: "42",
} as const;

describe("runMessageAction threading auto-injection", () => {
  beforeEach(() => {
    installMessageActionRunnerTestRegistry();
  });

  afterEach(() => {
    resetMessageActionRunnerTestRegistry();
    mocks.executeSendAction.mockClear();
    mocks.recordSessionMetaFromInbound.mockClear();
  });

  it.each([
    {
      name: "exact channel id",
      target: "channel:C123",
      threadTs: "111.222",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:111.222",
    },
    {
      name: "case-insensitive channel id",
      target: "channel:c123",
      threadTs: "333.444",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:333.444",
    },
  ] as const)("auto-threads slack using $name", async (testCase) => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: testCase.target,
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: testCase.threadTs,
        replyToMode: "all",
      },
    });

    expect(call?.ctx?.agentId).toBe("main");
    expect(call?.ctx?.mirror?.sessionKey).toBe(testCase.expectedSessionKey);
  });

  it.each([
    {
      name: "injects threadId for matching target",
      target: "telegram:123",
      expectedThreadId: "42",
    },
    {
      name: "injects threadId for prefixed group target",
      target: "telegram:group:123",
      expectedThreadId: "42",
    },
    {
      name: "skips threadId when target chat differs",
      target: "telegram:999",
      expectedThreadId: undefined,
    },
  ] as const)("telegram auto-threading: $name", async (testCase) => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfigAllowWithinProvider,
      actionParams: {
        channel: "telegram",
        target: testCase.target,
        message: "hi",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.ctx?.params?.threadId).toBe(testCase.expectedThreadId);
    if (testCase.expectedThreadId !== undefined) {
      expect(call?.threadId).toBe(testCase.expectedThreadId);
    }
  });

  it("uses explicit telegram threadId when provided", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        threadId: "999",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.threadId).toBe("999");
    expect(call?.ctx?.params?.threadId).toBe("999");
  });

  it("threads explicit replyTo through executeSendAction", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        replyTo: "777",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.replyToId).toBe("777");
    expect(call?.ctx?.params?.replyTo).toBe("777");
  });
});
