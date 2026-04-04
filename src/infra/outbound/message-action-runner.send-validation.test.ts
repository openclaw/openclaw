import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChannelDirectoryEntryKind,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) =>
  runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    dryRun: true,
  });

type ResolvedTestTarget = { to: string; kind: ChannelDirectoryEntryKind };

const directOutbound: ChannelOutboundAdapter = { deliveryMode: "direct" };

function normalizeSlackTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("#")) {
    return trimmed.slice(1).trim();
  }
  if (/^channel:/i.test(trimmed)) {
    return trimmed.replace(/^channel:/i, "").trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.replace(/^user:/i, "").trim();
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention?.[1]) {
    return mention[1];
  }
  return trimmed;
}

function createConfiguredTestPlugin(params: {
  id: "slack" | "telegram";
  isConfigured: (cfg: OpenClawConfig) => boolean;
  normalizeTarget: (raw: string) => string | undefined;
  resolveTarget: (input: string) => ResolvedTestTarget | null;
}): ChannelPlugin {
  const messaging: ChannelMessagingAdapter = {
    normalizeTarget: params.normalizeTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(params.resolveTarget(raw.trim())),
      hint: "<id>",
      resolveTarget: async (resolverParams) => {
        const resolved = params.resolveTarget(resolverParams.input);
        return resolved ? { ...resolved, source: "normalized" } : null;
      },
    },
    inferTargetChatType: (inferParams) =>
      params.resolveTarget(inferParams.to)?.kind === "user" ? "direct" : "group",
  };
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: (_account, cfg) => params.isConfigured(cfg),
      },
    }),
    outbound: directOutbound,
    messaging,
  };
}

const slackTestPlugin = createConfiguredTestPlugin({
  id: "slack",
  isConfigured: (cfg) => Boolean(cfg.channels?.slack?.botToken?.trim()),
  normalizeTarget: (raw) => normalizeSlackTarget(raw) || undefined,
  resolveTarget: (input) => {
    const normalized = normalizeSlackTarget(input);
    if (!normalized) {
      return null;
    }
    if (/^[A-Z0-9]+$/i.test(normalized)) {
      const kind = /^U/i.test(normalized) ? "user" : "group";
      return { to: normalized, kind };
    }
    return null;
  },
});

const telegramTestPlugin = createConfiguredTestPlugin({
  id: "telegram",
  isConfigured: (cfg) => Boolean(cfg.channels?.telegram?.botToken?.trim()),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      to: normalized.replace(/^telegram:/i, ""),
      kind: normalized.startsWith("@") ? "user" : "group",
    };
  },
});

describe("runMessageAction send validation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackTestPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams: {
          channel: "slack",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("allows send when only shared interactive payloads are provided", async () => {
    const result = await runDrySend({
      cfg: {
        channels: {
          telegram: {
            botToken: "telegram-test",
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "telegram",
        target: "123456",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only Slack blocks are provided", async () => {
    const result = await runDrySend({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        blocks: [{ type: "divider" }],
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "structured poll params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
      },
    },
    {
      name: "string-encoded poll params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: "60",
        pollPublic: "true",
      },
    },
    {
      name: "snake_case poll params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        poll_question: "Ready?",
        poll_option: ["Yes", "No"],
        poll_public: "true",
      },
    },
    {
      name: "negative poll duration params",
      actionParams: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: -5,
      },
    },
  ])("rejects send actions that include $name", async ({ actionParams }) => {
    await expect(
      runDrySend({
        cfg: slackConfig,
        actionParams,
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });
});
