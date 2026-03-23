import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  executePollAction: vi.fn(),
}));

let runMessageAction: typeof import("./message-action-runner.js").runMessageAction;

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executePollAction: mocks.executePollAction,
  };
});

const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

const telegramPollTestPlugin: ChannelPlugin = {
  id: "telegram",
  meta: {
    id: "telegram",
    label: "Telegram",
    selectionLabel: "Telegram",
    docsPath: "/channels/telegram",
    blurb: "Telegram poll test plugin.",
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ botToken: "telegram-test" }),
    isConfigured: () => true,
  },
  messaging: {
    targetResolver: {
      looksLikeId: () => true,
      resolveTarget: async ({ normalized }) => ({
        to: normalized,
        kind: "user",
        source: "normalized",
      }),
    },
  },
  threading: {
    resolveAutoThreadId: ({ toolContext, to, replyToId }) => {
      if (replyToId) {
        return undefined;
      }
      if (toolContext?.currentChannelId !== to) {
        return undefined;
      }
      return toolContext.currentThreadTs;
    },
  },
};

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
  const call = mocks.executePollAction.mock.calls[0]?.[0] as
    | {
        resolveCorePoll?: () => {
          durationHours?: number;
          maxSelections?: number;
          threadId?: string;
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
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPollTestPlugin,
        },
      ]),
    );
    mocks.executePollAction.mockReset();
    mocks.executePollAction.mockImplementation(async (input) => ({
      handledBy: "core",
      payload: { ok: true, corePoll: input.resolveCorePoll() },
      pollResult: { ok: true },
    }));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.executePollAction.mockReset();
  });

  it("requires at least two poll options", async () => {
    await expect(
      runPollAction({
        cfg: telegramConfig,
        actionParams: {
          channel: "telegram",
          target: "telegram:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza"],
        },
      }),
    ).rejects.toThrow(/pollOption requires at least two values/i);
    expect(mocks.executePollAction).toHaveBeenCalledTimes(1);
  });

  it("passes shared poll fields and auto threadId to executePollAction", async () => {
    const call = await runPollAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollDurationHours: 2,
      },
      toolContext: {
        currentChannelId: "telegram:123",
        currentThreadTs: "42",
      },
    });

    expect(call?.durationHours).toBe(2);
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
