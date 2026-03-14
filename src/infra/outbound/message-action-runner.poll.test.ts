import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installMessageActionRunnerTestRegistry,
  resetMessageActionRunnerTestRegistry,
  slackConfig,
  telegramConfig,
} from "./message-action-runner.test-helpers.js";

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

import { runMessageAction } from "./message-action-runner.js";

async function runPollAction(params: {
  cfg: typeof slackConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) {
  await runMessageAction({
    cfg: params.cfg,
    action: "poll",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
  });
  return mocks.executePollAction.mock.calls[0]?.[0] as
    | {
        durationSeconds?: number;
        maxSelections?: number;
        threadId?: string;
        isAnonymous?: boolean;
        ctx?: { params?: Record<string, unknown> };
      }
    | undefined;
}
describe("runMessageAction poll handling", () => {
  beforeEach(() => {
    installMessageActionRunnerTestRegistry();
    mocks.executePollAction.mockResolvedValue({
      handledBy: "core",
      payload: { ok: true },
      pollResult: { ok: true },
    });
  });

  afterEach(() => {
    resetMessageActionRunnerTestRegistry();
    mocks.executePollAction.mockReset();
  });

  it.each([
    {
      name: "requires at least two poll options",
      cfg: telegramConfig,
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
      cfg: slackConfig,
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
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollPublic: true,
      },
      message: /pollAnonymous\/pollPublic are only supported for Telegram polls/i,
    },
  ])("$name", async ({ cfg, actionParams, message }) => {
    await expect(runPollAction({ cfg, actionParams })).rejects.toThrow(message);
    expect(mocks.executePollAction).not.toHaveBeenCalled();
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
