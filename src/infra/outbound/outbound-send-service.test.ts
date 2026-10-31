import { beforeEach, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { executePollAction, executeSendAction } from "./outbound-send-service.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  send: vi.fn<typeof import("./message.js").sendMessage>(),
  poll: vi.fn(),
  access: { localRoots: ["/agent"], readFile: async () => Buffer.from("capability") },
  resolveAccess:
    vi.fn<typeof import("../../media/read-capability.js").resolveAgentScopedOutboundMediaAccess>(),
  commit: vi.fn<
    typeof import("../../sessions/confirmed-visible-message.js").commitConfirmedVisibleMessage
  >(async () => ({ ok: true })),
}));
// mock-isolation: Exercise send-service routing without invoking real channel actions.
vi.mock("../../channels/plugins/message-action-dispatch.js", () => ({
  dispatchChannelMessageAction: mocks.dispatch,
}));
// mock-isolation: Capture outbound sends and polls without contacting a provider.
vi.mock("./message.js", () => ({ sendMessage: mocks.send, sendPoll: mocks.poll }));
// mock-isolation: Use fixture-owned media access without reading host files.
vi.mock("../../media/read-capability.js", () => ({
  createAgentScopedHostMediaReadFile: () => mocks.access.readFile,
  resolveAgentScopedOutboundMediaAccess: mocks.resolveAccess,
}));
// mock-isolation: Capture destination history without a session store.
vi.mock("../../sessions/confirmed-visible-message.js", () => ({
  commitConfirmedVisibleMessage: mocks.commit,
}));

type Send = Parameters<typeof executeSendAction>[0];
type Context = Omit<Partial<Send["ctx"]>, "input"> & { input?: Partial<Send["ctx"]["input"]> };
const destination = { to: "channel:123", message: "hello" };
const basePlugin = createChannelTestPluginBase({ id: "demo" });
const sent = { channel: "demo", to: destination.to, via: "direct" as const, mediaUrl: null };
const poll = {
  to: destination.to,
  question: "Lunch?",
  options: ["Pizza", "Sushi"],
  maxSelections: 1,
};
const gateway: NonNullable<Context["gateway"]> = {
  url: "http://127.0.0.1:18789",
  token: "tok",
  clientName: "gateway-client",
  mode: "backend",
};
const requester = {
  requesterSenderId: "attacker",
  requesterSenderName: "Alice",
  requesterSenderUsername: "alice_u",
  requesterSenderE164: "+15551234567",
};
const sourceSession = "agent:main:directchat:group:ops";
const transcriptRoute = {
  sessionKey: "agent:main:demo:channel:123",
  baseSessionKey: "agent:main:demo:channel:123",
  peer: { kind: "channel" as const, id: "123" },
  chatType: "channel" as const,
  from: "demo:channel:123",
  to: destination.to,
};
const chart: ReplyPayload["presentation"] = {
  blocks: [
    {
      type: "chart",
      chartType: "pie",
      title: "Revenue",
      segments: [{ label: "Product", value: 60 }],
    },
  ],
};
const presentation: ReplyPayload["presentation"] = { blocks: [{ type: "text", text: "Portable" }] };

function context({ input, ...overrides }: Context = {}): Send["ctx"] {
  const cfg = overrides.cfg ?? {};
  const params = overrides.params ?? destination;
  return {
    channelPlugin: basePlugin,
    channel: overrides.channelPlugin?.id ?? basePlugin.id,
    dryRun: false,
    ...overrides,
    cfg,
    params,
    input: { cfg, action: "send", params, ...input },
  };
}
function send(ctx: Context = {}, input: Partial<Omit<Send, "ctx">> = {}) {
  return executeSendAction({ ...destination, ...input, ctx: context(ctx) });
}
function plugin(
  mode?: "direct" | "gateway",
  actions: Partial<NonNullable<ChannelPlugin["actions"]>> = {},
): ChannelPlugin {
  return {
    ...basePlugin,
    actions: { describeMessageTool: () => ({ actions: ["send"] }), ...actions },
    ...(mode
      ? {
          outbound: {
            deliveryMode: mode,
            sendText: async () => ({ channel: "demo", messageId: "sent" }),
          },
        }
      : {}),
  };
}
function expectCall(mock: { mock: { calls: unknown[][] } }, expected: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(expected));
}

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue({ ok: true, value: { messageId: "plugin" } });
  mocks.send.mockResolvedValue(sent);
  mocks.resolveAccess.mockReturnValue(mocks.access);
});

it("reports the transport's effective text", async () => {
  mocks.dispatch.mockResolvedValue(null);
  mocks.send.mockImplementationOnce(async ({ onDeliveredPayload }) => {
    onDeliveredPayload?.({ text: "[Peer] hello", mediaUrls: [] });
    return { ...sent, deliveryStatus: "sent" };
  });
  expect((await send()).deliveredText).toBe("[Peer] hello");
});

it("forces durable core delivery and accepts the route before publishing its receipt", async () => {
  const order: string[] = [];
  const evidence = { channel: "demo", messageId: "sent" };
  const onDeliveryIntent = vi.fn();
  const onDeliveryResult = vi.fn(async () => {
    order.push("receipt");
  });
  mocks.send.mockImplementationOnce(async (params) => {
    await params.onDeliveryResult?.(evidence);
    return sent;
  });
  await send({
    onSendAccepted: async () => {
      order.push("route");
    },
    input: { requireQueuePersistence: true, onDeliveryIntent, onDeliveryResult },
  });
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expectCall(mocks.send, {
    queuePolicy: "required",
    requireUnknownSendReconciliation: false,
    onDeliveryIntent,
  });
  expect(order).toEqual(["route", "receipt"]);
  expect(onDeliveryResult).toHaveBeenCalledWith(evidence);
});

it.each([
  ["core", "source-account"],
  ["core", undefined],
  ["plugin", "source-account"],
  ["plugin", undefined],
] as const)("scopes %s media to requester %s", async (route, account) => {
  if (route === "core") {
    mocks.dispatch.mockResolvedValue(null);
  }
  await send({
    accountId: "destination-account",
    agentId: "work",
    conversationType: "channel",
    params: { media: "/host.png" },
    input: { sessionKey: sourceSession, requesterAccountId: account, ...requester },
  });
  expectCall(route === "core" ? mocks.send : mocks.resolveAccess, {
    ...requester,
    ...(route === "core"
      ? {
          requesterSessionKey: sourceSession,
          requesterAccountId: account ?? "destination-account",
          accountId: "destination-account",
          agentId: "work",
          conversationType: "channel",
        }
      : {
          sessionKey: sourceSession,
          accountId: account ?? "destination-account",
          messageProvider: undefined,
        }),
  });
});

it.each([
  ["direct", "", presentation, ""],
  ["gateway", "Trend", chart, "Trend\n\nRevenue (pie chart)\n- Product: 60"],
] as const)(
  "routes %s presentations through core delivery",
  async (mode, message, value, content) => {
    const payload = { text: message, presentation: value };
    const result = await send(
      {
        channelPlugin: plugin(mode),
        params: { to: destination.to, presentation: value },
        transcriptRoute,
        input: { runId: "presentation" },
      },
      { message, payload },
    );
    expect(result.handledBy).toBe("core");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expectCall(mocks.send, {
      content,
      payloads: [payload],
      transcriptRoute,
      runId: "presentation",
    });
  },
);

it("materializes charts for action-only plugins", async () => {
  const result = await send(
    {
      channelPlugin: plugin(),
      params: { presentation: chart },
    },
    { message: "", payload: { text: "", presentation: chart } },
  );
  expect(result.handledBy).toBe("plugin");
  expect(mocks.send).not.toHaveBeenCalled();
  expectCall(mocks.dispatch, {
    params: expect.objectContaining({
      presentation: chart,
      message: "Revenue (pie chart)\n- Product: 60",
    }),
  });
});

it.each([
  { source: "implicit", replyToId: "source-1", mode: "first" },
  { source: "explicit", replyToId: "explicit-1" },
] as const)("preserves host-owned $source replies through plugin fallback", async (reply) => {
  const components = () => [];
  const result = await send(
    {
      channelPlugin: plugin("direct", {
        prepareSendPayload: ({ ctx }) => {
          expect(ctx.reply).toEqual(reply);
          return null;
        },
      }),
      params: { ...destination, components, presentation, replyTo: reply.replyToId },
    },
    { reply, message: "Summary", payload: { text: "Summary", presentation } },
  );
  expect(result.handledBy).toBe("plugin");
  expectCall(mocks.dispatch, {
    reply,
    params: expect.objectContaining({
      components,
      replyTo: reply.replyToId,
      presentation,
      message: "Summary\n\nPortable",
    }),
  });
  expect(mocks.send).not.toHaveBeenCalled();
  expectCall(mocks.commit, {
    payload: expect.objectContaining({ text: "Summary\n\nPortable", presentation }),
  });
});

it.each([
  { params: {}, sources: [] },
  { params: { media: "/photo.png" }, sources: ["/photo.png"] },
  {
    params: { mediaUrls: ["/chart.png", ""], attachments: [{ filePath: "/report.md" }] },
    sources: ["/chart.png", "/report.md"],
  },
])("resolves plugin media sources $sources before dispatch", async ({ params, sources }) => {
  await send({ params, agentId: "agent-1" });
  expectCall(mocks.resolveAccess, { agentId: "agent-1", mediaSources: sources });
  expectCall(mocks.dispatch, {
    mediaLocalRoots: mocks.access.localRoots,
    mediaReadFile: mocks.access.readFile,
  });
});

it("preserves explicitly supplied media access", async () => {
  const mediaAccess = { localRoots: ["/explicit"], readFile: async () => Buffer.from("explicit") };
  mocks.resolveAccess.mockReturnValueOnce(mediaAccess);
  await send({ params: { mediaUrls: ["/chart.png"] }, mediaAccess });
  expectCall(mocks.resolveAccess, { mediaAccess, mediaSources: ["/chart.png"] });
  expectCall(mocks.dispatch, {
    mediaLocalRoots: mediaAccess.localRoots,
    mediaReadFile: mediaAccess.readFile,
  });
});

it("records plain plugin sends with fallback media under their delivery identity", async () => {
  const mediaUrls = ["https://example.com/a.png", "https://example.com/b.png"];
  const result = await send(
    { transcriptRoute, idempotencyKey: "idem-plugin-send-1" },
    { mediaUrls },
  );
  expect(result.handledBy).toBe("plugin");
  expect(result.deliveredText).toBeUndefined();
  expect(mocks.send).not.toHaveBeenCalled();
  expectCall(mocks.commit, {
    route: transcriptRoute,
    payload: expect.objectContaining({ text: "hello", mediaUrls }),
    deliveryId: "idem-plugin-send-1",
    payloadIndex: 0,
  });
});

it("keeps a confirmed plugin send when its history write fails", async () => {
  mocks.commit.mockRejectedValueOnce(new Error("transcript unavailable"));
  await expect(send()).resolves.toMatchObject({ handledBy: "plugin" });
  expect(mocks.send).not.toHaveBeenCalled();
});

it("leaves destination history to a delegating client on both send paths", async () => {
  const input = { callerRecordsDestinationHistory: true };
  await send({ input });
  expect(mocks.commit).not.toHaveBeenCalled();
  mocks.dispatch.mockResolvedValueOnce(null);
  await send({ input });
  expectCall(mocks.send, { skipDestinationHistory: true });
});

it("bypasses plugin sends during dry runs", async () => {
  await send({ dryRun: true, silent: true, gateway, idempotencyKey: "stable-send" });
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expectCall(mocks.send, { dryRun: true, silent: true, gateway, idempotencyKey: "stable-send" });
});

it.each([undefined, false])("queues prepared payloads (bestEffort: %s)", async (bestEffort) => {
  const reply = { replyToId: "reply-1", source: "explicit" as const };
  const prepareSendPayload = vi.fn<
    NonNullable<NonNullable<ChannelPlugin["actions"]>["prepareSendPayload"]>
  >(({ payload }) => ({ ...payload, channelData: { prepared: true } }));
  const selected = {
    ...plugin(undefined, { prepareSendPayload }),
    outbound: { deliveryMode: "direct" as const },
  };
  await send(
    {
      channelPlugin: selected,
      input: {
        sessionKey: "discord-session",
        inboundEventKind: "room_event",
        conversationReadOrigin: "delegated",
      },
    },
    { payload: { text: "hello", presentation }, bestEffort, reply, threadId: "thread-1" },
  );
  expectCall(prepareSendPayload, {
    ctx: expect.objectContaining({
      sessionKey: "discord-session",
      inboundEventKind: "room_event",
    }),
    replyToIdSource: "explicit",
  });
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expectCall(mocks.send, {
    queuePolicy: bestEffort === false ? "required" : "best_effort",
    reply,
    threadId: "thread-1",
    conversationReadOrigin: "delegated",
    preparedPlugin: selected,
    payloads: [expect.objectContaining({ channelData: { prepared: true }, presentation })],
  });
});

it("dispatches plugin polls before attempting shared parsing", async () => {
  const resolveCorePoll = vi.fn(() => {
    throw new Error("shared poll fallback should not run");
  });
  const result = await executePollAction({
    ctx: context({
      params: {
        pollQuestion: "Lunch?",
        pollOption: poll.options,
        pollDurationSeconds: 90,
        pollPublic: true,
      },
    }),
    resolveCorePoll,
  });
  expect(result.handledBy).toBe("plugin");
  expect(resolveCorePoll).not.toHaveBeenCalled();
  expect(mocks.poll).not.toHaveBeenCalled();
});

it.each([false, true])("forwards core polls (dryRun: %s)", async (dryRun) => {
  if (!dryRun) {
    mocks.dispatch.mockResolvedValue(null);
  }
  mocks.poll.mockResolvedValue({
    ...poll,
    channel: "demo",
    via: "gateway",
    durationHours: 6,
    durationSeconds: null,
  });
  const corePoll = dryRun
    ? { ...poll, durationHours: 6 }
    : {
        ...poll,
        content: "Vote now",
        durationSeconds: 300,
        threadId: "thread-1",
        isAnonymous: true,
      };
  const policy = dryRun
    ? { dryRun, silent: true, gateway, idempotencyKey: "stable-poll" }
    : {
        accountId: "acc-1",
        input: { sessionKey: transcriptRoute.sessionKey, inboundEventKind: "room_event" as const },
      };
  await executePollAction({ ctx: context(policy), resolveCorePoll: () => corePoll });
  if (dryRun) {
    expect(mocks.dispatch).not.toHaveBeenCalled();
  }
  expectCall(mocks.poll, {
    ...corePoll,
    ...(dryRun
      ? { dryRun, silent: true, gateway, idempotencyKey: "stable-poll" }
      : {
          accountId: "acc-1",
          sessionKey: transcriptRoute.sessionKey,
          inboundEventKind: "room_event",
        }),
  });
});
