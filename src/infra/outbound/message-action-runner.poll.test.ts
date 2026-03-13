import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

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

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

async function runPollAction(params: {
  cfg: OpenClawConfig;
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

let createPluginRuntime: typeof import("../../plugins/runtime/index.js").createPluginRuntime;
let setSlackRuntime: typeof import("../../../extensions/slack/src/runtime.js").setSlackRuntime;
let setTelegramRuntime: typeof import("../../../extensions/telegram/src/runtime.js").setTelegramRuntime;

describe("runMessageAction poll handling", () => {
  beforeAll(async () => {
    ({ createPluginRuntime } = await import("../../plugins/runtime/index.js"));
    ({ setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js"));
    ({ setTelegramRuntime } = await import("../../../extensions/telegram/src/runtime.js"));
  });

  beforeEach(() => {
    const runtime = createPluginRuntime();
    setSlackRuntime(runtime);
    setTelegramRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );
    mocks.executePollAction.mockResolvedValue({
      handledBy: "core",
      payload: { ok: true },
      pollResult: { ok: true },
    });
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
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
