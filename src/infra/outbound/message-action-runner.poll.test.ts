// Covers message-action poll handling through plugin dispatch and core gateway
// poll fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthorizationPolicyHandler } from "../../plugins/authorization-policy.types.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const mocks = vi.hoisted(() => ({
  executePreparedPollAction: vi.fn(),
  preparePollAction: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} params to be an object`);
  }
  return arg as Record<string, unknown>;
}

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
  resetOutboundChannelResolutionStateForTest: vi.fn(),
}));

vi.mock("./outbound-send-service.js", () => ({
  executeSendAction: vi.fn(async () => {
    throw new Error("executeSendAction should not run in poll tests");
  }),
  prepareSendAction: vi.fn(async () => {
    throw new Error("prepareSendAction should not run in poll tests");
  }),
  executePreparedSendAction: vi.fn(async () => {
    throw new Error("executePreparedSendAction should not run in poll tests");
  }),
  executePreparedPollAction: mocks.executePreparedPollAction,
  preparePollAction: mocks.preparePollAction,
  waitForPreparedSendEffectAuthorization: vi.fn(async () => {}),
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  return createOutboundThreadingMock();
});
const pollerConfig = {
  channels: {
    poller: {
      botToken: "poller-test",
    },
  },
} as OpenClawConfig;

const pollerTestPlugin: ChannelPlugin = {
  id: "poller",
  meta: {
    id: "poller",
    label: "Poller",
    selectionLabel: "Poller",
    docsPath: "/channels/poller",
    blurb: "Poller test plugin.",
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ botToken: "poller-test" }),
    isConfigured: () => true,
  },
  outbound: {
    deliveryMode: "gateway",
    sendPoll: async () => ({
      messageId: "poll-test",
    }),
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
  inboundEventKind?: "user_request" | "room_event";
}) {
  await runMessageAction({
    cfg: params.cfg,
    action: "poll",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    inboundEventKind: params.inboundEventKind,
  });
  const call = firstMockArg(mocks.preparePollAction, "preparePollAction") as {
    resolveCorePoll?: () => {
      durationHours?: number;
      maxSelections?: number;
      threadId?: string;
    };
    ctx?: { inboundEventKind?: string; params?: Record<string, unknown> };
  };
  return {
    ...call.resolveCorePoll?.(),
    ctx: call.ctx,
  };
}

describe("runMessageAction poll handling", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "poller",
          source: "test",
          plugin: pollerTestPlugin,
        },
      ]),
    );
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    mocks.preparePollAction.mockReset();
    mocks.preparePollAction.mockImplementation((input) => ({
      kind: "core",
      ctx: input.ctx,
      poll: input.resolveCorePoll(),
    }));
    mocks.executePreparedPollAction.mockReset();
    mocks.executePreparedPollAction.mockImplementation(async (prepared) => ({
      handledBy: "core",
      payload: { ok: true, corePoll: prepared.poll },
      pollResult: { ok: true },
    }));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.preparePollAction.mockReset();
    mocks.executePreparedPollAction.mockReset();
  });

  it("requires at least two poll options", async () => {
    await expect(
      runPollAction({
        cfg: pollerConfig,
        actionParams: {
          channel: "poller",
          target: "poller:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza"],
        },
      }),
    ).rejects.toThrow(/pollOption requires at least two values/i);
    expect(mocks.preparePollAction).toHaveBeenCalledTimes(1);
    expect(mocks.executePreparedPollAction).not.toHaveBeenCalled();
  });

  it("passes shared poll fields and auto threadId to the prepared action", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollDurationHours: 2,
      },
      toolContext: {
        currentChannelId: "poller:123",
        currentThreadTs: "42",
      },
    });

    expect(call?.durationHours).toBe(2);
    expect(call?.threadId).toBe("42");
    expect(call?.ctx?.params?.threadId).toBe("42");
  });

  it("authorizes the normalized core poll plan before execution", async () => {
    let seenInput: Record<string, unknown> | undefined;
    const handler: AuthorizationPolicyHandler<"message.action"> = (request) => {
      seenInput = request.input;
      return request.input.pollMulti === true
        ? { effect: "deny", code: "multiselect-blocked" }
        : { effect: "pass" };
    };
    const registry = getActivePluginRegistry();
    if (!registry) {
      throw new Error("expected active plugin registry");
    }
    registry.authorizationPolicies.push({
      pluginId: "poll-policy-test",
      pluginName: "Poll policy test",
      origin: "workspace",
      source: "test",
      policy: {
        id: "poll-policy-test",
        description: "Tests normalized poll authorization",
        handlers: { "message.action": handler },
      },
    });

    await expect(
      runMessageAction({
        cfg: pollerConfig,
        action: "poll",
        params: {
          channel: "poller",
          target: "poller:123",
          pollQuestion: " Lunch? ",
          pollOption: [" Pizza ", " Sushi "],
          pollMulti: "true",
          pollDurationHours: "2",
          silent: "true",
        },
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(seenInput).toMatchObject({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 2,
      durationHours: 2,
      pollQuestion: "Lunch?",
      pollOption: ["Pizza", "Sushi"],
      pollMulti: true,
      pollDurationHours: 2,
      silent: true,
    });
    expect(mocks.executePreparedPollAction).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, "1.5", "soon"])(
    "rejects invalid pollDurationHours value %s",
    async (pollDurationHours) => {
      await expect(
        runPollAction({
          cfg: pollerConfig,
          actionParams: {
            channel: "poller",
            target: "poller:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationHours,
          },
        }),
      ).rejects.toThrow(/pollDurationHours must be a positive integer/i);
    },
  );

  it("passes inbound event kind to poll execution", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
      },
      inboundEventKind: "room_event",
    });

    expect(call?.ctx?.inboundEventKind).toBe("room_event");
  });

  it("expands maxSelections when pollMulti is enabled", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
        pollMulti: true,
      },
    });

    expect(call?.maxSelections).toBe(3);
  });

  it("defaults maxSelections to one choice when pollMulti is omitted", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
      },
    });

    expect(call?.maxSelections).toBe(1);
  });
});
