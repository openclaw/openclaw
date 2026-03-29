import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { expect, vi } from "vitest";
import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { createPluginRuntimeMock } from "./plugin-runtime-mock.js";

type ResolvedFeishuAccount = {
  accountId: string;
  selectionSource: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: string;
  config: Record<string, unknown>;
};

const { monitorSingleAccount } = loadBundledPluginPublicSurfaceSync<{
  monitorSingleAccount: (params: {
    cfg: ClawdbotConfig;
    account: ResolvedFeishuAccount;
    runtime: RuntimeEnv;
    botOpenIdSource: typeof FEISHU_PREFETCHED_BOT_OPEN_ID_SOURCE;
  }) => Promise<void>;
}>({
  pluginId: "feishu",
  artifactBasename: "src/monitor.account.js",
});
const { setFeishuRuntime } = loadBundledPluginPublicSurfaceSync<{
  setFeishuRuntime: (runtime: PluginRuntime) => void;
}>({
  pluginId: "feishu",
  artifactBasename: "src/runtime.js",
});

type InboundDebouncerParams<T> = {
  onFlush?: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};

export function setFeishuLifecycleStateDir(prefix: string) {
  process.env.OPENCLAW_STATE_DIR = `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function restoreFeishuLifecycleStateDir(originalStateDir: string | undefined) {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
    return;
  }
  process.env.OPENCLAW_STATE_DIR = originalStateDir;
}

export const FEISHU_PREFETCHED_BOT_OPEN_ID_SOURCE = {
  kind: "prefetched",
  botOpenId: "ou_bot_1",
  botName: "Bot",
} as const;

export function createFeishuLifecycleReplyDispatcher() {
  return {
    dispatcher: {
      sendToolResult: vi.fn(() => false),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(async () => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  };
}

export function createImmediateInboundDebounce() {
  return {
    resolveInboundDebounceMs: vi.fn(() => 0),
    createInboundDebouncer: <T>(params: InboundDebouncerParams<T>) => ({
      enqueue: async (item: T) => {
        try {
          await params.onFlush?.([item]);
        } catch (err) {
          params.onError?.(err, [item]);
        }
      },
      flushKey: async () => {},
    }),
  };
}

export function installFeishuLifecycleRuntime(params: {
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
  finalizeInboundContext: PluginRuntime["channel"]["reply"]["finalizeInboundContext"];
  dispatchReplyFromConfig: PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
  withReplyDispatcher: PluginRuntime["channel"]["reply"]["withReplyDispatcher"];
  resolveStorePath: PluginRuntime["channel"]["session"]["resolveStorePath"];
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
  shouldComputeCommandAuthorized?: PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"];
  resolveCommandAuthorizedFromAuthorizers?: PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"];
  readAllowFromStore?: PluginRuntime["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest?: PluginRuntime["channel"]["pairing"]["upsertPairingRequest"];
  buildPairingReply?: PluginRuntime["channel"]["pairing"]["buildPairingReply"];
  detectMime?: PluginRuntime["media"]["detectMime"];
}) {
  setFeishuRuntime(
    createPluginRuntimeMock({
      channel: {
        debounce: createImmediateInboundDebounce(),
        text: {
          hasControlCommand: params.hasControlCommand ?? vi.fn(() => false),
        },
        routing: {
          resolveAgentRoute: params.resolveAgentRoute,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatAgentEnvelope: vi.fn((value: { body: string }) => value.body),
          finalizeInboundContext: params.finalizeInboundContext,
          dispatchReplyFromConfig: params.dispatchReplyFromConfig,
          withReplyDispatcher: params.withReplyDispatcher,
        },
        commands: {
          shouldComputeCommandAuthorized:
            params.shouldComputeCommandAuthorized ?? vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers:
            params.resolveCommandAuthorizedFromAuthorizers ?? vi.fn(() => false),
        },
        session: {
          readSessionUpdatedAt: vi.fn(),
          resolveStorePath: params.resolveStorePath,
        },
        pairing: {
          readAllowFromStore: params.readAllowFromStore ?? vi.fn().mockResolvedValue([]),
          upsertPairingRequest: params.upsertPairingRequest ?? vi.fn(),
          buildPairingReply: params.buildPairingReply ?? vi.fn(),
        },
      },
      media: {
        detectMime: params.detectMime ?? vi.fn(async () => "text/plain"),
      },
    }) as unknown as PluginRuntime,
  );
}

export function installFeishuLifecycleReplyRuntime(params: {
  resolveAgentRouteMock: unknown;
  finalizeInboundContextMock: unknown;
  dispatchReplyFromConfigMock: unknown;
  withReplyDispatcherMock: unknown;
  storePath: string;
}) {
  installFeishuLifecycleRuntime({
    resolveAgentRoute:
      params.resolveAgentRouteMock as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
    finalizeInboundContext:
      params.finalizeInboundContextMock as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
    dispatchReplyFromConfig:
      params.dispatchReplyFromConfigMock as PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"],
    withReplyDispatcher:
      params.withReplyDispatcherMock as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
    resolveStorePath: vi.fn(() => params.storePath),
  });
}

export function mockFeishuReplyOnceDispatch(params: {
  dispatchReplyFromConfigMock: {
    mockImplementation: (
      fn: (args: {
        ctx?: unknown;
        dispatcher?: {
          sendFinalReply?: (payload: { text: string }) => Promise<unknown>;
        };
      }) => Promise<unknown>,
    ) => void;
  };
  replyText: string;
  shouldSendFinalReply?: (ctx: unknown) => boolean;
}) {
  params.dispatchReplyFromConfigMock.mockImplementation(async ({ ctx, dispatcher }) => {
    const shouldSendFinalReply = params.shouldSendFinalReply?.(ctx) ?? true;
    if (shouldSendFinalReply && typeof dispatcher?.sendFinalReply === "function") {
      await dispatcher.sendFinalReply({ text: params.replyText });
    }
    return {
      queuedFinal: false,
      counts: { final: shouldSendFinalReply ? 1 : 0 },
    };
  });
}

export function createFeishuLifecycleConfig(params: {
  accountId: string;
  appId: string;
  appSecret: string;
  channelConfig?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
}): ClawdbotConfig {
  const extraConfig = params.extraConfig ?? {};
  return {
    ...extraConfig,
    channels: {
      ...(extraConfig.channels as Record<string, unknown> | undefined),
      feishu: {
        enabled: true,
        requireMention: false,
        resolveSenderNames: false,
        ...params.channelConfig,
        accounts: {
          [params.accountId]: {
            enabled: true,
            appId: params.appId,
            appSecret: params.appSecret, // pragma: allowlist secret
            connectionMode: "websocket",
            requireMention: false,
            resolveSenderNames: false,
            ...params.accountConfig,
          },
        },
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 0,
        },
      },
    },
  } as ClawdbotConfig;
}

export function createFeishuLifecycleFixture(params: {
  accountId: string;
  appId: string;
  appSecret: string;
  channelConfig?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
}) {
  return {
    cfg: createFeishuLifecycleConfig(params),
    account: createResolvedFeishuLifecycleAccount({
      accountId: params.accountId,
      appId: params.appId,
      appSecret: params.appSecret,
      config: {
        ...params.channelConfig,
        ...params.accountConfig,
      },
    }),
  };
}

export function createResolvedFeishuLifecycleAccount(params: {
  accountId: string;
  appId: string;
  appSecret: string;
  config: Record<string, unknown>;
}): ResolvedFeishuAccount {
  return {
    accountId: params.accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: params.appId,
    appSecret: params.appSecret, // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
      requireMention: false,
      resolveSenderNames: false,
      ...params.config,
    },
  } as unknown as ResolvedFeishuAccount;
}

export function createFeishuTextMessageEvent(params: {
  messageId: string;
  chatId: string;
  text: string;
  chatType?: "group" | "p2p";
  senderOpenId?: string;
  rootId?: string;
  threadId?: string;
}) {
  return {
    sender: {
      sender_id: { open_id: params.senderOpenId ?? "ou_sender_1" },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
      chat_id: params.chatId,
      chat_type: params.chatType ?? "group",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      create_time: "1710000000000",
    },
  };
}

export async function replayFeishuLifecycleEvent(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  waitForFirst: () => void | Promise<void>;
  waitForSecond?: () => void | Promise<void>;
}) {
  await params.handler(params.event);
  await vi.waitFor(params.waitForFirst);
  await params.handler(params.event);
  await vi.waitFor(params.waitForSecond ?? params.waitForFirst);
}

export async function runFeishuLifecycleSequence(
  deliveries: Array<() => Promise<void>>,
  waits: Array<() => void | Promise<void>>,
) {
  for (const [index, deliver] of deliveries.entries()) {
    await deliver();
    await vi.waitFor(waits[index] ?? waits.at(-1) ?? (() => {}));
  }
}

export async function expectFeishuSingleEffectAcrossReplay(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  effectMock: ReturnType<typeof vi.fn>;
  effectCount?: number;
}) {
  const effectCount = params.effectCount ?? 1;
  await replayFeishuLifecycleEvent({
    handler: params.handler,
    event: params.event,
    waitForFirst: () => {
      expect(params.effectMock).toHaveBeenCalledTimes(effectCount);
    },
  });
}

export async function expectFeishuReplyPipelineDedupedAcrossReplay(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  dispatchReplyFromConfigMock: ReturnType<typeof vi.fn>;
  createFeishuReplyDispatcherMock: ReturnType<typeof vi.fn>;
  waitTimeoutMs?: number;
}) {
  const waitTimeoutMs = params.waitTimeoutMs;
  await replayFeishuLifecycleEvent({
    handler: params.handler,
    event: params.event,
    waitForFirst: () =>
      vi.waitFor(
        () => {
          expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
        },
        waitTimeoutMs == null ? undefined : { timeout: waitTimeoutMs },
      ),
    waitForSecond: () =>
      vi.waitFor(
        () => {
          expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
          expect(params.createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
        },
        waitTimeoutMs == null ? undefined : { timeout: waitTimeoutMs },
      ),
  });
}

export async function expectFeishuReplyPipelineDedupedAfterPostSendFailure(params: {
  handler: (data: unknown) => Promise<void>;
  event: unknown;
  dispatchReplyFromConfigMock: ReturnType<typeof vi.fn>;
  runtimeErrorMock: ReturnType<typeof vi.fn>;
}) {
  await replayFeishuLifecycleEvent({
    handler: params.handler,
    event: params.event,
    waitForFirst: () => {
      expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(params.runtimeErrorMock).toHaveBeenCalledTimes(1);
    },
    waitForSecond: () => {
      expect(params.dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
      expect(params.runtimeErrorMock).toHaveBeenCalledTimes(1);
    },
  });
}

export function expectFeishuReplyDispatcherSentFinalReplyOnce(params: {
  createFeishuReplyDispatcherMock: ReturnType<typeof vi.fn>;
}) {
  const dispatcher = params.createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
    sendFinalReply: ReturnType<typeof vi.fn>;
  };
  expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
}

export async function setupFeishuLifecycleHandler<T extends RuntimeEnv>(params: {
  createEventDispatcherMock: {
    mockReturnValue: (value: unknown) => unknown;
    mockReturnValueOnce: (value: unknown) => unknown;
  };
  onRegister: (registered: Record<string, (data: unknown) => Promise<void>>) => void;
  runtime: T;
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  handlerKey: string;
  missingHandlerMessage: string;
  once?: boolean;
}): Promise<(data: unknown) => Promise<void>> {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    params.onRegister(registered);
  });
  if (params.once) {
    params.createEventDispatcherMock.mockReturnValueOnce({ register });
  } else {
    params.createEventDispatcherMock.mockReturnValue({ register });
  }

  await monitorSingleAccount({
    cfg: params.cfg,
    account: params.account,
    runtime: params.runtime,
    botOpenIdSource: FEISHU_PREFETCHED_BOT_OPEN_ID_SOURCE,
  });

  const handlers: Record<string, (data: unknown) => Promise<void>> = {};
  for (const [key, value] of Object.entries(register.mock.calls[0]?.[0] ?? {})) {
    handlers[key] = value as (data: unknown) => Promise<void>;
  }
  const handler = handlers[params.handlerKey];
  if (!handler) {
    throw new Error(params.missingHandlerMessage);
  }
  return handler;
}
