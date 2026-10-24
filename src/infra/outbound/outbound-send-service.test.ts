import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

const mocks = vi.hoisted(() => {
  const getAgentScopedMediaLocalRootsForSources = vi.fn<
    (params: { cfg: unknown; agentId?: string; mediaSources?: readonly string[] }) => string[]
  >(() => ["/tmp/agent-roots"]);
  const createAgentScopedHostMediaReadFile = vi.fn<
    (params: { cfg: unknown; agentId?: string }) => (filePath: string) => Promise<Buffer>
  >(() => async () => Buffer.from("capability"));
  return {
    getDefaultMediaLocalRoots: vi.fn(() => []),
    dispatchChannelMessageAction: vi.fn(),
    sendMessage: vi.fn(),
    sendPoll: vi.fn(),
    getAgentScopedMediaLocalRootsForSources,
    createAgentScopedHostMediaReadFile,
    resolveAgentScopedOutboundMediaAccess: vi.fn<
      typeof import("../../media/read-capability.js").resolveAgentScopedOutboundMediaAccess
    >((params) => ({
      localRoots:
        params.mediaAccess?.localRoots ??
        getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfg,
          agentId: params.agentId,
          mediaSources: params.mediaSources ?? [],
        }),
      readFile:
        params.mediaAccess?.readFile ??
        params.mediaReadFile ??
        createAgentScopedHostMediaReadFile({
          cfg: params.cfg,
          agentId: params.agentId,
        }),
    })),
    appendAssistantMessageToSessionTranscript: vi.fn(async () => ({
      ok: true,
      target: { sessionId: "x", sessionKey: "x", storePath: "/tmp/sessions.json" },
    })),
  };
});

vi.mock("../../channels/plugins/message-action-dispatch.js", () => ({
  dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
}));

vi.mock("./message.js", () => ({
  sendMessage: mocks.sendMessage,
  sendPoll: mocks.sendPoll,
}));

vi.mock("../../media/read-capability.js", () => ({
  createAgentScopedHostMediaReadFile: mocks.createAgentScopedHostMediaReadFile,
  resolveAgentScopedOutboundMediaAccess: mocks.resolveAgentScopedOutboundMediaAccess,
}));

vi.mock("../../media/local-roots.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/local-roots.js")>(
    "../../media/local-roots.js",
  );
  return {
    ...actual,
    getDefaultMediaLocalRoots: mocks.getDefaultMediaLocalRoots,
    getAgentScopedMediaLocalRootsForSources: mocks.getAgentScopedMediaLocalRootsForSources,
  };
});

vi.mock("../../config/sessions/transcript.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/transcript.runtime.js")>()),
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

type OutboundSendServiceModule = typeof import("./outbound-send-service.js");
type ExecuteSendInput = Parameters<OutboundSendServiceModule["executeSendAction"]>[0];
type ExecuteSendContext = ExecuteSendInput["ctx"];
type Presentation = NonNullable<ReplyPayload["presentation"]>;
type ContextOverrides = Omit<Partial<ExecuteSendContext>, "input"> & {
  input?: Partial<ExecuteSendContext["input"]>;
};

function createContext(overrides: ContextOverrides): ExecuteSendContext {
  const { input, ...ctx } = overrides;
  const cfg = ctx.cfg ?? {};
  const params = ctx.params ?? {};
  return {
    channelPlugin: defaultPlugin,
    channel: "demo-outbound",
    dryRun: false,
    ...ctx,
    cfg,
    params,
    input: { cfg, action: "send", params, ...input },
  };
}

let executePollAction: OutboundSendServiceModule["executePollAction"];
let executeSendAction: OutboundSendServiceModule["executeSendAction"];

function send(ctx: ContextOverrides, input: Partial<Omit<ExecuteSendInput, "ctx">> = {}) {
  return executeSendAction({
    to: "channel:123",
    message: "hello",
    ...input,
    ctx: createContext(ctx),
  });
}

function sendMedia(
  params: ExecuteSendContext["params"],
  input: Partial<Omit<ExecuteSendInput, "ctx">>,
  mediaAccess?: ExecuteSendContext["mediaAccess"],
) {
  return send(
    { params: { ...defaultSendParams, ...params }, agentId: "agent-1", mediaAccess },
    input,
  );
}

const defaultSendParams = { to: "channel:123", message: "hello" };
const sentMessage = {
  channel: "demo-outbound",
  to: "channel:123",
  via: "direct" as const,
  mediaUrl: null,
  deliveryStatus: "sent" as const,
};
const poll = {
  to: "channel:123",
  question: "Lunch?",
  options: ["Pizza", "Sushi"],
  maxSelections: 1,
};
const pollResult = {
  ...poll,
  channel: "demo-outbound",
  durationSeconds: null,
  durationHours: null,
  via: "gateway",
};

type MockCalls = {
  mock: { calls: unknown[][] };
};

const requireRecord = createRequireRecord("object", "expected-label");
const defaultPlugin = createChannelTestPluginBase({ id: "demo-outbound" });
const pluginResult = { ok: true, value: { messageId: "msg-plugin" } };

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function present(block: Presentation["blocks"][number]): Presentation {
  return { blocks: [block] };
}

function expectFields(actual: unknown, expected: Record<string, unknown>) {
  expect(actual).toEqual(expect.objectContaining(expected));
}

function expectSingleCallFields(
  mock: MockCalls,
  expected: Record<string, unknown> = {},
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  const firstArg = requireRecord(mock.mock.calls[0]?.[0], "mock first argument");
  expectFields(firstArg, expected);
  return firstArg;
}

describe("executeSendAction", () => {
  function actionPlugin(
    id: string,
    deliveryMode?: "direct" | "gateway",
    actions: Partial<NonNullable<ChannelPlugin["actions"]>> = {},
  ): ChannelPlugin {
    return {
      ...createChannelTestPluginBase({ id }),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction: async () => ({ content: [], details: { ok: true } }),
        ...actions,
      },
      ...(deliveryMode && {
        outbound: {
          deliveryMode,
          sendText: async () => ({ channel: id, messageId: "msg-test" }),
        },
      }),
    };
  }

  function expectMirrorWrite(expected: Partial<NonNullable<ExecuteSendContext["mirror"]>>) {
    expectSingleCallFields(mocks.appendAssistantMessageToSessionTranscript, {
      ...expected,
      config: {},
    });
  }

  async function executePluginMirroredSend(params: {
    mirror?: Partial<{
      sessionKey: string;
      agentId?: string;
      idempotencyKey?: string;
    }>;
    mediaUrls?: string[];
  }) {
    await send(
      {
        params: { to: "channel:123", message: "hello" },
        mirror: {
          sessionKey: "agent:main:demo-outbound:channel:123",
          ...params.mirror,
        },
      },
      { mediaUrls: params.mediaUrls },
    );
  }

  function createPluginMediaSendContext(overrides: ContextOverrides): ExecuteSendContext {
    return createContext({
      params: { media: "/tmp/host.png" },
      ...overrides,
      input: {
        sessionKey: "agent:main:directchat:group:ops",
        ...overrides.input,
      },
    });
  }

  async function executePluginMediaSend(ctx: ContextOverrides) {
    await executeSendAction({
      ctx: createPluginMediaSendContext(ctx),
      to: "channel:123",
      message: "hello",
    });
  }

  beforeAll(async () => {
    ({ executePollAction, executeSendAction } = await import("./outbound-send-service.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
    }
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginResult);
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });
  });

  it("reports delivery-layer effective text instead of the pre-adapter message", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockImplementationOnce(async (params: unknown) => {
      const sendParams = requireRecord(params, "send message params");
      const onDeliveredPayload = sendParams.onDeliveredPayload;
      expect(onDeliveredPayload).toBeTypeOf("function");
      (onDeliveredPayload as (payload: { text: string; mediaUrls: string[] }) => void)({
        text: "[Peer] hello",
        mediaUrls: [],
      });
      return sentMessage;
    });
    const result = await send({ params: defaultSendParams });
    expect(result.deliveredText).toBe("[Peer] hello");
  });

  it("makes required queue persistence force core delivery and lifecycle callbacks", async () => {
    const onDeliveryIntent = vi.fn();
    const order: string[] = [];
    const onSendAccepted = vi.fn(async () => {
      order.push("route");
    });
    const onDeliveryResult = vi.fn(async () => {
      order.push("receipt");
    });
    const evidence = { channel: "demo-outbound", messageId: "sent-1" };
    mocks.sendMessage.mockImplementationOnce(async (params) => {
      await params.onDeliveryResult(evidence);
      return sentMessage;
    });
    await send({
      params: defaultSendParams,
      onSendAccepted,
      input: {
        requireQueuePersistence: true,
        onDeliveryResult,
        onDeliveryIntent,
      },
    });
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expectSingleCallFields(mocks.sendMessage, {
      queuePolicy: "required",
      requireUnknownSendReconciliation: false,
      onDeliveryIntent,
    });
    expect(order).toEqual(["route", "receipt"]);
    expect(onDeliveryResult).toHaveBeenCalledWith(evidence);
  });

  it("forwards agent and requester context to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);

    await send({
      conversationType: "channel",
      accountId: "destination-account",
      agentId: "work",
      input: {
        sessionKey: "agent:main:directchat:group:ops",
        requesterAccountId: "source-account",
        requesterSenderId: "attacker",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
      },
    });

    expectSingleCallFields(mocks.sendMessage, {
      requesterSessionKey: "agent:main:directchat:group:ops",
      conversationType: "channel",
      requesterAccountId: "source-account",
      requesterSenderId: "attacker",
      accountId: "destination-account",
      agentId: "work",
      channel: "demo-outbound",
      to: "channel:123",
      content: "hello",
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
    });
  });

  it.each(["source-account", undefined])(
    "scopes media policy to requester context (account: %s)",
    async (requesterAccountId) => {
      const requester = {
        requesterSenderId: "attacker",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
      };
      await executePluginMediaSend({
        accountId: "destination-account",
        input: { requesterAccountId, ...requester },
      });

      expectSingleCallFields(mocks.resolveAgentScopedOutboundMediaAccess, {
        sessionKey: "agent:main:directchat:group:ops",
        messageProvider: undefined,
        accountId: requesterAccountId ?? "destination-account",
        ...requester,
      });
    },
  );

  it("falls back to destination account when forwarding requester context to sendMessage", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);

    await executeSendAction({
      ctx: createContext({
        accountId: "destination-account",
        input: {
          sessionKey: "agent:main:directchat:group:ops",
          requesterSenderId: "attacker",
        },
      }),
      to: "channel:123",
      message: "hello",
    });

    expectSingleCallFields(mocks.sendMessage, {
      requesterSessionKey: "agent:main:directchat:group:ops",
      requesterAccountId: "destination-account",
    });
  });

  it.each([
    ["", present({ type: "text", text: "Presentation-only payload" })],
    [
      "Deployment trend",
      present({
        type: "chart",
        chartType: "bar",
        title: "Deployments",
        categories: ["Mon", "Tue"],
        series: [{ name: "Production", values: [2, 3] }],
      }),
    ],
  ] as const)(
    "routes presentations through the core path (text: %s)",
    async (message, presentation) => {
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "discord" }),
        outbound: {
          deliveryMode: "direct",
          sendText: async () => ({ channel: "discord", messageId: "msg-test" }),
        },
      };
      mocks.sendMessage.mockResolvedValue({
        channel: "discord",
        to: "channel:123",
        via: "direct",
        mediaUrl: null,
      });

      const mirror = { sessionKey: "agent:main:discord:channel:123", agentId: "main" };
      const result = await send(
        {
          channelPlugin: plugin,
          channel: "discord",
          params: { to: "channel:123", ...(message ? { message } : {}), presentation },
          ...(!message ? { mirror, input: { runId: "run-presentation-delivery" } } : {}),
        },
        { message, payload: { text: message, presentation } },
      );

      expect(result.handledBy).toBe("core");
      expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
      const sendArgs = expectSingleCallFields(mocks.sendMessage, {
        content: message,
        ...(!message ? { runId: "run-presentation-delivery", mirror } : {}),
      });
      expect(sendArgs.payloads).toEqual([{ text: message, presentation }]);
    },
  );

  it("keeps presentations on the plugin action path when payload preparation declines", async () => {
    const presentation = present({ type: "text", text: "Portable fallback" });
    const nativeComponents = () => [];
    const prepareSendPayload = vi.fn(() => null);
    const plugin = actionPlugin("discord", "direct", { prepareSendPayload });
    const result = await send(
      {
        channelPlugin: plugin,
        channel: "discord",
        params: { to: "channel:123", components: nativeComponents, presentation },
        mirror: {
          sessionKey: "agent:main:discord:channel:123",
          agentId: "main",
          text: "Summary",
        },
      },
      { message: "Summary", payload: { text: "Summary", presentation } },
    );
    expect(result.handledBy).toBe("plugin");
    expect(prepareSendPayload).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    const actionCtx = expectSingleCallFields(mocks.dispatchChannelMessageAction);
    const actionParams = requireRecord(actionCtx.params, "plugin action params");
    expect(actionParams.components).toBe(nativeComponents);
    expectFields(actionParams, { message: "Summary\n\nPortable fallback", presentation });
    expectMirrorWrite({
      sessionKey: "agent:main:discord:channel:123",
      agentId: "main",
      text: "Summary\n\nPortable fallback",
    });
  });

  it("materializes chart data for legacy gateway delivery", async () => {
    const presentation = present({
      type: "chart",
      chartType: "bar",
      title: "Deployments",
      categories: ["Mon", "Tue"],
      series: [{ name: "Production", values: [2, 3] }],
    });
    const plugin = actionPlugin("whatsapp", "gateway");
    mocks.sendMessage.mockResolvedValue({
      channel: "whatsapp",
      to: "+15551234567",
      via: "gateway",
      mediaUrl: null,
    });
    await send(
      {
        channelPlugin: plugin,
        channel: "whatsapp",
        params: { to: "+15551234567", message: "Deployment trend", presentation },
      },
      {
        to: "+15551234567",
        message: "Deployment trend",
        payload: { text: "Deployment trend", presentation },
      },
    );
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expectSingleCallFields(mocks.sendMessage, {
      content: "Deployment trend\n\nDeployments (bar chart)\n- Production: Mon: 2; Tue: 3",
      payloads: [{ text: "Deployment trend", presentation }],
    });
  });

  it("materializes chart data for action-only plugins", async () => {
    const presentation = present({
      type: "chart",
      chartType: "pie",
      title: "Revenue mix",
      segments: [
        { label: "Product", value: 60 },
        { label: "Services", value: 40 },
      ],
    });
    const plugin = actionPlugin("discord", undefined, {
      describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
    });
    const result = await send(
      {
        channelPlugin: plugin,
        channel: "discord",
        params: { to: "channel:123", presentation },
      },
      { message: "", payload: { text: "", presentation } },
    );
    expect(result.handledBy).toBe("plugin");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    const actionCtx = expectSingleCallFields(mocks.dispatchChannelMessageAction);
    expectFields(requireRecord(actionCtx.params, "plugin action params"), {
      message: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
      presentation,
    });
  });

  it("keeps non-presentation sends on the plugin action path", async () => {
    const result = await executeSendAction({
      ctx: createContext({
        params: { to: "channel:123", message: "hello" },
      }),
      to: "channel:123",
      message: "hello",
      payload: { text: "hello" },
    });

    expect(result.handledBy).toBe("plugin");
    expect(result.deliveredText).toBeUndefined();
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "implicit first reply",
      reply: { source: "implicit", replyToId: "source-1", mode: "first" } as const,
    },
    {
      label: "explicit reply while configured replies are off",
      reply: { source: "explicit", replyToId: "explicit-1" } as const,
    },
  ])("passes the host-owned $label through direct plugin fallback", async ({ reply }) => {
    const prepareSendPayload = vi.fn(({ ctx }) => {
      expect(ctx.reply).toEqual(reply);
      return null;
    });
    const handleAction = vi.fn(async (ctx) => {
      expect(ctx.params.components).toBeTypeOf("function");
      return { content: [], details: { ok: true } };
    });
    const plugin = actionPlugin("discord", "direct", {
      describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
      prepareSendPayload,
      handleAction,
    });
    mocks.dispatchChannelMessageAction.mockImplementation(async (ctx) => {
      return await plugin.actions?.handleAction?.(ctx);
    });
    const components = () => [];
    const result = await send(
      {
        channelPlugin: plugin,
        channel: "discord",
        params: { to: "channel:123", message: "hello", components, replyTo: reply.replyToId },
      },
      { reply },
    );
    expect(result.handledBy).toBe("plugin");
    expect(prepareSendPayload).toHaveBeenCalledOnce();
    expect(handleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ components, replyTo: reply.replyToId }),
        reply,
      }),
    );
  });

  it("does not invoke shared poll parsing before plugin poll dispatch", async () => {
    const resolveCorePoll = vi.fn(() => {
      throw new Error("shared poll fallback should not run");
    });
    const result = await executePollAction({
      ctx: createContext({
        params: {
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 90,
          pollPublic: true,
        },
      }),
      resolveCorePoll,
    });
    expect(result.handledBy).toBe("plugin");
    expect(resolveCorePoll).not.toHaveBeenCalled();
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("passes agent-scoped media local roots to plugin dispatch", async () => {
    await executeSendAction({
      ctx: createContext({
        params: { to: "channel:123", message: "hello" },
        agentId: "agent-1",
      }),
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
      cfg: {},
      agentId: "agent-1",
      mediaSources: [],
    });
    expectSingleCallFields(mocks.dispatchChannelMessageAction, {
      mediaLocalRoots: ["/tmp/agent-roots"],
      mediaReadFile: mocks.createAgentScopedHostMediaReadFile.mock.results[0]?.value,
    });
  });

  it.each([
    {
      name: "concrete media sources",
      params: { media: "/Users/peter/Pictures/photo.png" },
      input: { mediaUrl: "/Users/peter/Pictures/photo.png" },
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    },
    {
      name: "mediaUrls and structured attachment sources",
      params: {
        mediaUrls: ["/workspace/Pictures/chart.png", ""],
        attachments: [{ filePath: "/workspace/Documents/report.md" }],
      },
      input: { mediaUrls: ["/workspace/Pictures/chart.png"] },
      mediaSources: ["/workspace/Pictures/chart.png", "/workspace/Documents/report.md"],
    },
  ])(
    "passes $name when widening plugin dispatch roots",
    async ({ params, input, mediaSources }) => {
      await sendMedia(params, input);
      expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
        cfg: {},
        agentId: "agent-1",
        mediaSources,
      });
    },
  );

  it("preserves explicit plugin send media access roots", async () => {
    const explicitReadFile = vi.fn(async () => Buffer.from("explicit capability"));
    const mediaUrls = ["/workspace/Pictures/chart.png"];
    await sendMedia(
      { mediaUrls },
      { mediaUrls },
      {
        localRoots: ["/explicit-root"],
        readFile: explicitReadFile,
      },
    );
    const resolveArg = expectSingleCallFields(mocks.resolveAgentScopedOutboundMediaAccess);
    const passedMediaAccess = requireRecord(resolveArg.mediaAccess, "source-scoped media access");
    expect(resolveArg.mediaSources).toEqual(["/workspace/Pictures/chart.png"]);
    expect(passedMediaAccess.localRoots).toEqual(["/explicit-root"]);
    expect(passedMediaAccess.readFile).toBe(explicitReadFile);
    expect(mocks.getAgentScopedMediaLocalRootsForSources).not.toHaveBeenCalled();
    expectSingleCallFields(mocks.dispatchChannelMessageAction, {
      mediaLocalRoots: ["/explicit-root"],
      mediaReadFile: explicitReadFile,
    });
  });

  it("passes mirror idempotency keys through plugin-handled sends", async () => {
    await send({
      params: defaultSendParams,
      mirror: {
        sessionKey: "agent:main:demo-outbound:channel:123",
        idempotencyKey: "idem-plugin-send-1",
      },
    });
    expectMirrorWrite({
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
      idempotencyKey: "idem-plugin-send-1",
    });
  });

  it("falls back to message and media params for plugin-handled mirror writes", async () => {
    await executePluginMirroredSend({
      mirror: {
        agentId: "agent-9",
      },
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });

    expectMirrorWrite({
      agentId: "agent-9",
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });
  });

  it("skips plugin dispatch during dry-run sends and forwards gateway + silent to sendMessage", async () => {
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "gateway",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: createContext({
        params: { to: "channel:123", message: "hello" },
        idempotencyKey: "stable-send-key",
        dryRun: true,
        silent: true,
        gateway: {
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      }),
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    const sendArgs = expectSingleCallFields(mocks.sendMessage, {
      to: "channel:123",
      content: "hello",
      dryRun: true,
      silent: true,
      idempotencyKey: "stable-send-key",
    });
    expectFields(requireRecord(sendArgs.gateway, "send gateway"), {
      url: "http://127.0.0.1:18789",
      token: "tok",
      timeoutMs: 5000,
    });
  });

  it.each([undefined, false])(
    "routes prepared payloads through core delivery (bestEffort: %s)",
    async (bestEffort) => {
      const presentation = present({ type: "text", text: "Prepared presentation" });
      const prepareSendPayload = vi.fn(({ payload }) => ({
        ...payload,
        channelData: { prepared: true },
      }));
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          prepareSendPayload,
          handleAction: async () => ({ content: [], details: { ok: true } }),
        },
        outbound: { deliveryMode: "direct" },
      };
      mocks.sendMessage.mockResolvedValue({
        channel: "discord",
        to: "channel:123",
        via: "direct",
        mediaUrl: null,
      });

      await executeSendAction({
        ctx: createContext({
          channelPlugin: plugin,
          channel: "discord",
          params: { to: "channel:123", message: "hello" },
          input: {
            sessionKey: "discord-session",
            inboundEventKind: "room_event",
            conversationReadOrigin: "delegated",
          },
        }),
        to: "channel:123",
        message: "hello",
        payload: { text: "hello", presentation },
        bestEffort,
        reply: { replyToId: "reply-1", source: "explicit" },
        threadId: "thread-1",
      });

      expect(prepareSendPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            sessionKey: "discord-session",
            inboundEventKind: "room_event",
          }),
          replyToIdSource: "explicit",
        }),
      );
      expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
      const sendArgs = expectSingleCallFields(mocks.sendMessage, {
        channel: "discord",
        queuePolicy: bestEffort === false ? "required" : "best_effort",
        reply: { replyToId: "reply-1", source: "explicit" },
        threadId: "thread-1",
        conversationReadOrigin: "delegated",
      });
      expect(sendArgs.preparedPlugin).toBe(plugin);
      const [payload] = requireArray(sendArgs.payloads, "send payloads");
      expectFields(requireRecord(payload, "prepared payload"), {
        channelData: { prepared: true },
        presentation,
      });
    },
  );

  it("forwards poll args to sendPoll on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendPoll.mockResolvedValue(pollResult);
    const corePoll = {
      ...poll,
      content: "Vote now",
      durationSeconds: 300,
      threadId: "thread-1",
      isAnonymous: true,
    };
    await executePollAction({
      ctx: createContext({
        accountId: "acc-1",
        input: {
          sessionKey: "agent:main:demo-outbound:channel:123",
          inboundEventKind: "room_event",
        },
      }),
      resolveCorePoll: () => corePoll,
    });
    expectSingleCallFields(mocks.sendPoll, {
      channel: "demo-outbound",
      accountId: "acc-1",
      ...corePoll,
      sessionKey: "agent:main:demo-outbound:channel:123",
      inboundEventKind: "room_event",
    });
  });

  it("skips plugin dispatch during dry-run polls and forwards durationHours + silent", async () => {
    mocks.sendPoll.mockResolvedValue({ ...pollResult, durationHours: 6 });
    await executePollAction({
      ctx: createContext({
        idempotencyKey: "stable-poll-key",
        dryRun: true,
        silent: true,
        gateway: {
          url: "http://127.0.0.1:18789",
          token: "tok",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      }),
      resolveCorePoll: () => ({
        ...poll,
        durationHours: 6,
      }),
    });
    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    const pollArgs = expectSingleCallFields(mocks.sendPoll, {
      to: "channel:123",
      question: "Lunch?",
      durationHours: 6,
      dryRun: true,
      silent: true,
      idempotencyKey: "stable-poll-key",
    });
    expectFields(requireRecord(pollArgs.gateway, "poll gateway"), {
      url: "http://127.0.0.1:18789",
      token: "tok",
      timeoutMs: 5000,
    });
  });
});
