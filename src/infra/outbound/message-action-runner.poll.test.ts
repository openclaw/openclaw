import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  executePollAction: vi.fn(),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executePollAction: mocks.executePollAction,
  };
});

type MessageActionRunnerModule = typeof import("./message-action-runner.js");
type MessageActionRunnerTestHelpersModule =
  typeof import("./message-action-runner.test-helpers.js");

let runMessageAction: MessageActionRunnerModule["runMessageAction"];
let installMessageActionRunnerTestRegistry: MessageActionRunnerTestHelpersModule["installMessageActionRunnerTestRegistry"];
let resetMessageActionRunnerTestRegistry: MessageActionRunnerTestHelpersModule["resetMessageActionRunnerTestRegistry"];
let slackConfig: MessageActionRunnerTestHelpersModule["slackConfig"];
let telegramConfig: MessageActionRunnerTestHelpersModule["telegramConfig"];

async function runPollAction(params: {
  cfg: MessageActionRunnerTestHelpersModule["slackConfig"];
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) {
  await runMessageAction({
    cfg: params.cfg,
    action: "poll",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
  });
  const call = mocks.executePollAction.mock.calls[0]?.[0] as
    | {
        resolveCorePoll?: () => {
          durationSeconds?: number;
          maxSelections?: number;
          threadId?: string;
          isAnonymous?: boolean;
        };
        ctx?: { params?: Record<string, unknown> };
      }
    | undefined;
  if (!call) {
    return undefined;
  }
  return {
    ...call.resolveCorePoll?.(),
    ctx: call.ctx,
  };
}
describe("runMessageAction poll handling", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ runMessageAction } = await import("./message-action-runner.js"));
    ({
      installMessageActionRunnerTestRegistry,
      resetMessageActionRunnerTestRegistry,
      slackConfig,
      telegramConfig,
    } = await import("./message-action-runner.test-helpers.js"));
    installMessageActionRunnerTestRegistry();
    mocks.executePollAction.mockImplementation(async (input) => ({
      handledBy: "core",
      payload: { ok: true, corePoll: input.resolveCorePoll() },
      pollResult: { ok: true },
    }));
  });

  afterEach(() => {
    resetMessageActionRunnerTestRegistry?.();
    mocks.executePollAction.mockReset();
  });

  it.each([
    {
      name: "requires at least two poll options",
      getCfg: () => telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza"],
      },
      message: /pollOption requires at least two values/i,
    },
    {
      name: "rejects durationSeconds outside telegram",
      getCfg: () => slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollDurationSeconds: 60,
      },
      message: /pollDurationSeconds is only supported for Telegram polls/i,
    },
    {
      name: "rejects poll visibility outside telegram",
      getCfg: () => slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollPublic: true,
      },
      message: /pollAnonymous\/pollPublic are only supported for Telegram polls/i,
    },
  ])("$name", async ({ getCfg, actionParams, message }) => {
    await expect(runPollAction({ cfg: getCfg(), actionParams })).rejects.toThrow(message);
    expect(mocks.executePollAction).toHaveBeenCalledTimes(1);
  });

  it("passes Telegram durationSeconds, visibility, and auto threadId to executePollAction", async () => {
    const call = await runPollAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollDurationSeconds: 90,
        pollPublic: true,
      },
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
    });

    expect(call?.durationSeconds).toBe(90);
    expect(call?.isAnonymous).toBe(false);
    expect(call?.threadId).toBe("42");
    expect(call?.ctx?.params?.threadId).toBe("42");
  });

  it("expands maxSelections when pollMulti is enabled", async () => {
    const call = await runPollAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
        pollMulti: true,
      },
    });

    expect(call?.maxSelections).toBe(3);
  });

  it("defaults maxSelections to one choice when pollMulti is omitted", async () => {
    const call = await runPollAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
      },
    });

    expect(call?.maxSelections).toBe(1);
  });
});
