import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.public.js";
import { pinRuntimePaths } from "../../config/paths.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { drainPendingDeliveriesCore } from "./delivery-queue-recovery.js";
import type { OutboundMessageGatewayOptionsInput } from "./message-gateway-options.js";

function registerPlugin(
  id: string,
  outbound: ChannelOutboundAdapter,
  aliases: string[] = [],
  options: Omit<Parameters<typeof createChannelTestPluginBase>[0], "id"> = {},
) {
  const base = createChannelTestPluginBase({ id, ...options });
  const plugin: ChannelPlugin = { ...base, meta: { ...base.meta, aliases }, outbound };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
}

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  callGatewayLeastPrivilege: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

let sendMessage: typeof import("./message.js").sendMessage;
let sendPoll: typeof import("./message.js").sendPoll;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(async () => {
  ({ sendMessage, sendPoll } = await import("./message.js"));
});

beforeEach(() => {
  callGatewayMock.mockClear();
  setActivePluginRegistry(emptyRegistry);
});

afterEach(() => {
  setActivePluginRegistry(emptyRegistry);
});

function gatewayCall() {
  const [call] = callGatewayMock.mock.calls;
  if (!call) {
    throw new Error("expected gateway call");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected gateway call input to be an object");
  }
  return arg as {
    url?: string;
    token?: string;
    timeoutMs?: number;
    params?: Record<string, unknown>;
  };
}

function sendThreadMessage(params: Partial<Parameters<typeof sendMessage>[0]> = {}) {
  return sendMessage({
    cfg: {},
    to: "channel:town-square",
    channel: "threadchat",
    content: "hi",
    ...params,
  });
}

function sendDemoPoll(params: Partial<Parameters<typeof sendPoll>[0]> = {}) {
  return sendPoll({
    cfg: {},
    to: "conversation:demo-target",
    channel: "Workspace-Chat",
    question: "Lunch?",
    options: ["Pizza", "Sushi"],
    ...params,
  });
}

it("keeps ephemeral-authority sends out of recovery after revocation", async () => {
  const stateDir = tempDirs.make("openclaw-live-only-delivery-");
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      pinRuntimePaths();
      let authorityActive = true;
      const sendText = vi.fn(async (ctx: { onPlatformSendDispatch?: () => Promise<void> }) => {
        await ctx.onPlatformSendDispatch?.();
        return { channel: "threadchat", messageId: "live-only-1" };
      });
      registerPlugin("threadchat", { deliveryMode: "direct", sendText });
      const onDeliveryIntent = vi.fn(() => {
        throw new Error("simulated crash after queue persistence");
      });

      await sendThreadMessage({
        content: "live only",
        skipQueue: true,
        onDeliveryIntent,
        onPlatformSendDispatch: async () => {
          if (!authorityActive) {
            throw new Error("delivery authority revoked");
          }
        },
      });
      expect(onDeliveryIntent).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledOnce();

      authorityActive = false;
      const recoveredDelivery = vi.fn(async () => []);
      await drainPendingDeliveriesCore({
        drainKey: `live-only-${stateDir}`,
        logLabel: "Live-only delivery test",
        cfg: {},
        stateDir,
        deliver: recoveredDelivery,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        selectEntry: () => ({ match: true, bypassBackoff: true }),
      });
      expect(recoveredDelivery).not.toHaveBeenCalled();
    });
  } finally {
    pinRuntimePaths();
  }
});

it("threads resolved cfg through alias + target normalization in outbound dispatch", async () => {
  const resolvedCfg = {
    __resolvedCfgMarker: "cfg-from-secret-resolution",
    channels: {},
  } as Record<string, unknown>;
  const seen: {
    resolveCfg?: unknown;
    sendCfg?: unknown;
    to?: string;
  } = {};
  registerPlugin(
    "localchat",
    {
      deliveryMode: "direct",
      resolveTarget: ({ to, cfg }) => {
        seen.resolveCfg = cfg;
        const normalized = (to ?? "").trim().replace(/^localchat:/i, "");
        return { ok: true, to: normalized };
      },
      sendText: async ({ cfg, to }) => {
        seen.sendCfg = cfg;
        seen.to = to;
        return { channel: "localchat", messageId: "local-resolved" };
      },
    },
    ["localmsg"],
    { label: "LocalChat", config: { listAccountIds: () => [] } },
  );

  const result = await sendMessage({
    cfg: resolvedCfg,
    to: " localchat:+15551234567 ",
    content: "hi",
    channel: "localmsg",
  });

  expect(result.channel).toBe("localchat");
  expect(seen.resolveCfg).toBe(resolvedCfg);
  expect(seen.sendCfg).toBe(resolvedCfg);
  expect(seen.to).toBe("+15551234567");
});

describe("sendMessage replyToId threading", () => {
  const setupThreadChatCapture = () => {
    const capturedCtx: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0][] = [];
    registerPlugin(
      "threadchat",
      {
        deliveryMode: "direct",
        sendText: async (ctx) => {
          capturedCtx.push(ctx);
          return { channel: "threadchat", messageId: "m1" };
        },
      },
      [],
      { label: "ThreadChat", capabilities: { chatTypes: ["direct", "channel"] } },
    );
    return capturedCtx;
  };

  it.each([
    ["replyToId", "post123", "thread reply"],
    ["threadId", "topic456", "topic reply"],
  ] as const)("passes %s through to the outbound adapter", async (field, expected, content) => {
    const capturedCtx = setupThreadChatCapture();
    await sendThreadMessage({ content, [field]: expected });

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0]?.[field]).toBe(expected);
  });
});

function setDemoPollRegistry(outboundOptions: Parameters<typeof createDemoAliasOutbound>[0] = {}) {
  registerPlugin(
    "demo-alias-channel",
    createDemoAliasOutbound(outboundOptions),
    ["workspace-chat"],
    {
      label: "Demo Alias Channel",
      config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    },
  );
}

describe("sendPoll channel normalization", () => {
  it.each(["send", "poll"] as const)(
    "keeps hosted %s delivery on its bound Gateway",
    async (method) => {
      setDemoPollRegistry({ deliveryMode: "gateway" });
      const resolveAgentRuntimeIdentityToken = vi.fn();
      const gateway: OutboundMessageGatewayOptionsInput = {
        request: async () => {
          throw new Error("unexpected unconfigured Gateway request");
        },
        resolveAgentRuntimeIdentityToken,
      };
      const request = vi.spyOn(gateway, "request").mockResolvedValue({ messageId: "owned-1" });
      const common = {
        cfg: {},
        to: "conversation:demo-target",
        channel: "workspace-chat",
        idempotencyKey: "owned-delivery",
        gateway,
      };
      const result =
        method === "send"
          ? await sendMessage({ ...common, content: "hello" })
          : await sendPoll({ ...common, question: "Lunch?", options: ["Pizza", "Sushi"] });

      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method,
          params: expect.objectContaining({
            channel: "demo-alias-channel",
            idempotencyKey: "owned-delivery",
          }),
        }),
      );
      expect(result.result).toMatchObject({ messageId: "owned-1" });
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(resolveAgentRuntimeIdentityToken).not.toHaveBeenCalled();
    },
  );

  it("normalizes plugin aliases for gateway polls", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1", channelId: "channel-1" });
    setDemoPollRegistry({ deliveryMode: "gateway" });

    const result = await sendDemoPoll({
      idempotencyKey: "stable-poll-key",
    });

    expect(gatewayCall()?.params?.channel).toBe("demo-alias-channel");
    expect(gatewayCall()?.params?.idempotencyKey).toBe("stable-poll-key");
    expect(result.channel).toBe("demo-alias-channel");
    expect(result.via).toBe("gateway");
    expect(result.result).toEqual({
      messageId: "p1",
      target: { kind: "channel", id: "channel-1" },
    });
  });

  it("uses direct poll fallback for direct channel plugins", async () => {
    const cfg = { channels: {} };
    const sendPollMock = vi.fn(async () => ({ messageId: "p1", conversationId: "conv-1" }));
    setDemoPollRegistry({ supportsAnonymousPolls: true, sendPoll: sendPollMock });

    const result = await sendDemoPoll({
      cfg,
      accountId: "acct-1",
      threadId: "thread-1",
      silent: true,
      isAnonymous: false,
    });

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channel: "demo-alias-channel",
      to: "conversation:demo-target",
      via: "direct",
      result: {
        messageId: "p1",
        target: { kind: "conversation", id: "conv-1" },
      },
    });
    expect(sendPollMock).toHaveBeenCalledWith({
      cfg,
      to: "conversation:demo-target",
      poll: {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
      },
      accountId: "acct-1",
      threadId: "thread-1",
      silent: true,
      isAnonymous: false,
    });
  });

  it.each([
    ["durationSeconds", { durationSeconds: 300 }],
    ["isAnonymous", { isAnonymous: false }],
  ] as const)("rejects unsupported direct poll option %s", async (name, params) => {
    const sendPollMock = vi.fn(async () => ({ messageId: "p1" }));
    setDemoPollRegistry({ sendPoll: sendPollMock });

    await expect(sendDemoPoll(params)).rejects.toThrow(
      `${name} is not supported for demo-alias-channel polls`,
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(sendPollMock).not.toHaveBeenCalled();
  });
});

const setThreadChatGatewayRegistry = () =>
  registerPlugin("threadchat", { deliveryMode: "gateway" }, [], {
    label: "ThreadChat",
    capabilities: { chatTypes: ["direct", "channel"] },
  });

describe("gateway url override hardening", () => {
  const sendThreadChatGatewayMessage = async (
    params: Partial<Parameters<typeof sendMessage>[0]> = {},
  ) => {
    setThreadChatGatewayRegistry();
    callGatewayMock.mockResolvedValueOnce({
      messageId: params.agentId ? "m-agent" : "m1",
    });
    await sendThreadMessage(params);
    return gatewayCall();
  };

  it.each([
    {
      name: "preserves the prepared local connection for a hosted Gateway send",
      params: {
        gateway: {
          config: { gateway: { mode: "remote" as const, port: 18789 } },
          localPortOverride: 18789,
          ignoreEnvUrlOverride: true,
          tlsFingerprint: "fixture-fingerprint",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      },
      expected: {
        config: { gateway: { mode: "remote", port: 18789 } },
        localPortOverride: 18789,
        ignoreEnvUrlOverride: true,
        tlsFingerprint: "fixture-fingerprint",
      },
    },
    {
      name: "drops gateway url overrides in backend mode (SSRF hardening)",
      params: {
        gateway: {
          url: "ws://169.254.169.254:80/latest/meta-data/",
          token: "t",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          clientDisplayName: "agent",
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      },
      expected: {
        url: undefined,
        token: "t",
        timeoutMs: 5000,
      },
    },
  ])("$name", async ({ params, expected }) => {
    const result = await sendThreadChatGatewayMessage(params);
    for (const [key, value] of Object.entries(expected)) {
      expect((result as Record<string, unknown>)[key]).toEqual(value);
    }
  });

  it.each([
    { name: "agentId", params: { agentId: "work" } },
    { name: "replyToId", params: { replyToId: "wamid.42" } },
    {
      name: "delivery options",
      params: {
        threadId: "topic456",
        forceDocument: true,
        silent: true,
        parseMode: "HTML" as const,
      },
    },
    { name: "idempotency key", params: { idempotencyKey: "stable-send-key" } },
  ])("forwards $name in gateway send params", async ({ params }) => {
    const result = await sendThreadChatGatewayMessage(params);
    expect(result.params).toMatchObject(params);
  });

  it("forwards buffer metadata for gateway delivery-mode sends", async () => {
    const media = {
      mediaUrl: "buffer://message-send/attachment",
      mediaUrls: ["buffer://message-send/attachment"],
      buffer: Buffer.from("gateway delivery bytes").toString("base64"),
      filename: "delivery.txt",
      contentType: "text/plain",
    };
    const result = await sendThreadChatGatewayMessage({
      ...media,
      mediaUrls: [...media.mediaUrls],
    });
    expect(result.params).toMatchObject(media);
  });

  it("rejects revoked authority before a gateway send RPC", async () => {
    setThreadChatGatewayRegistry();
    const onPlatformSendDispatch = vi.fn(async () => {
      throw new Error("delivery authority revoked");
    });

    await expect(
      sendThreadMessage({
        onPlatformSendDispatch,
      }),
    ).rejects.toThrow("delivery authority revoked");

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("carries live authority across a gateway send RPC", async () => {
    setThreadChatGatewayRegistry();
    let authorityActive = true;
    const queueDelivery = vi.fn();
    const platformSend = vi.fn();
    callGatewayMock.mockImplementationOnce(async (call: { agentRuntimeIdentityToken?: string }) => {
      if (call.agentRuntimeIdentityToken && !authorityActive) {
        throw new Error("agent runtime authority is no longer active");
      }
      queueDelivery();
      platformSend();
      return { messageId: "must-not-send" };
    });

    await expect(
      sendThreadMessage({
        content: "must not escape",
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          resolveAgentRuntimeIdentityToken: async () => "runtime-identity",
        },
        onPlatformSendDispatch: async () => {
          authorityActive = false;
        },
      }),
    ).rejects.toThrow("agent runtime authority is no longer active");

    expect(queueDelivery).not.toHaveBeenCalled();
    expect(platformSend).not.toHaveBeenCalled();
  });

  it("drops unused buffer metadata when explicit gateway media is present", async () => {
    const result = await sendThreadChatGatewayMessage({
      mediaUrl: "https://example.com/photo.png",
      buffer: Buffer.from("ignored bytes").toString("base64"),
      filename: "ignored.txt",
      contentType: "text/plain",
    });

    expect(result.params).toMatchObject({
      mediaUrl: "https://example.com/photo.png",
    });
    expect(result.params?.buffer).toBeUndefined();
    expect(result.params?.filename).toBeUndefined();
    expect(result.params?.contentType).toBeUndefined();
  });
});

const emptyRegistry = createTestRegistry([]);

const createDemoAliasOutbound = (
  opts: {
    deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
    supportsAnonymousPolls?: boolean;
    sendPoll?: NonNullable<ChannelOutboundAdapter["sendPoll"]>;
  } = {},
): ChannelOutboundAdapter => ({
  deliveryMode: opts.deliveryMode ?? "direct",
  sendText: async ({ deps, to, text }) => {
    const send = deps?.["demo-alias-channel"] as
      | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
      | undefined;
    if (!send) {
      throw new Error("demo-alias-channel missing");
    }
    const result = await send(to, text);
    return { channel: "demo-alias-channel", ...result };
  },
  pollMaxOptions: 12,
  ...(opts.supportsAnonymousPolls ? { supportsAnonymousPolls: true } : {}),
  sendPoll: opts.sendPoll ?? (async () => ({ messageId: "p1" })),
});
