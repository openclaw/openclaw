import { request as httpRequest } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/zalo";
import { expect, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { withServer } from "../http-test-server.js";
import { createPluginRuntimeMock } from "./plugin-runtime-mock.js";
import { createRuntimeEnv } from "./runtime-env.js";

export { withServer };

type ResolvedZaloAccount = {
  accountId: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "configFile" | "none";
  config: Record<string, unknown>;
};

const { clearZaloWebhookSecurityStateForTest, monitorZaloProvider } =
  loadBundledPluginPublicSurfaceSync<{
    clearZaloWebhookSecurityStateForTest: () => void;
    monitorZaloProvider: (params: {
      token: string;
      account: ResolvedZaloAccount;
      config: OpenClawConfig;
      runtime: ReturnType<typeof createRuntimeEnv>;
      abortSignal: AbortSignal;
      useWebhook?: boolean;
      webhookUrl?: string;
      webhookSecret?: string;
    }) => Promise<unknown>;
  }>({
    pluginId: "zalo",
    artifactBasename: "src/monitor.js",
  });
const { normalizeSecretInputString } = loadBundledPluginPublicSurfaceSync<{
  normalizeSecretInputString: (value: unknown) => string | undefined;
}>({
  pluginId: "zalo",
  artifactBasename: "src/secret-input.js",
});

const lifecycleMocks = vi.hoisted(() => ({
  setWebhookMock: vi.fn(async () => ({ ok: true, result: { url: "" } })),
  deleteWebhookMock: vi.fn(async () => ({ ok: true, result: { url: "" } })),
  getWebhookInfoMock: vi.fn(async () => ({ ok: true, result: { url: "" } })),
  getUpdatesMock: vi.fn(() => new Promise(() => {})),
  sendChatActionMock: vi.fn(async () => ({ ok: true })),
  sendMessageMock: vi.fn(async () => ({
    ok: true,
    result: { message_id: "zalo-test-reply-1" },
  })),
  sendPhotoMock: vi.fn(async () => ({ ok: true })),
  getZaloRuntimeMock: vi.fn(),
}));

export const setWebhookMock = lifecycleMocks.setWebhookMock;
export const deleteWebhookMock = lifecycleMocks.deleteWebhookMock;
export const getWebhookInfoMock = lifecycleMocks.getWebhookInfoMock;
export const getUpdatesMock = lifecycleMocks.getUpdatesMock;
export const sendChatActionMock = lifecycleMocks.sendChatActionMock;
export const sendMessageMock = lifecycleMocks.sendMessageMock;
export const sendPhotoMock = lifecycleMocks.sendPhotoMock;
export const getZaloRuntimeMock = lifecycleMocks.getZaloRuntimeMock;

vi.mock("../../../extensions/zalo/src/api.ts", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    deleteWebhook: lifecycleMocks.deleteWebhookMock,
    getUpdates: lifecycleMocks.getUpdatesMock,
    getWebhookInfo: lifecycleMocks.getWebhookInfoMock,
    sendChatAction: lifecycleMocks.sendChatActionMock,
    sendMessage: lifecycleMocks.sendMessageMock,
    sendPhoto: lifecycleMocks.sendPhotoMock,
    setWebhook: lifecycleMocks.setWebhookMock,
  };
});

vi.mock("../../../extensions/zalo/src/runtime.ts", () => ({
  getZaloRuntime: lifecycleMocks.getZaloRuntimeMock,
}));

export function resetLifecycleTestState() {
  vi.clearAllMocks();
  clearZaloWebhookSecurityStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
}

export function createLifecycleConfig(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}): OpenClawConfig {
  const webhookUrl = params.webhookUrl ?? "https://example.com/hooks/zalo";
  const webhookSecret = params.webhookSecret ?? "supersecret";
  return {
    channels: {
      zalo: {
        enabled: true,
        accounts: {
          [params.accountId]: {
            enabled: true,
            webhookUrl,
            webhookSecret, // pragma: allowlist secret
            dmPolicy: params.dmPolicy,
            ...(params.allowFrom ? { allowFrom: params.allowFrom } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
}

export function createLifecycleAccount(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}): ResolvedZaloAccount {
  const webhookUrl = params.webhookUrl ?? "https://example.com/hooks/zalo";
  const webhookSecret = params.webhookSecret ?? "supersecret";
  return {
    accountId: params.accountId,
    enabled: true,
    token: "zalo-token",
    tokenSource: "config",
    config: {
      webhookUrl,
      webhookSecret, // pragma: allowlist secret
      dmPolicy: params.dmPolicy,
      ...(params.allowFrom ? { allowFrom: params.allowFrom } : {}),
    },
  } as ResolvedZaloAccount;
}

export function createLifecycleMonitorSetup(params: {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}) {
  return {
    account: createLifecycleAccount(params),
    config: createLifecycleConfig(params),
  };
}

export function createTextUpdate(params: {
  messageId: string;
  userId: string;
  userName: string;
  chatId: string;
  text?: string;
}) {
  return {
    event_name: "message.text.received",
    message: {
      from: { id: params.userId, name: params.userName },
      chat: { id: params.chatId, chat_type: "PRIVATE" as const },
      message_id: params.messageId,
      date: Math.floor(Date.now() / 1000),
      text: params.text ?? "hello from zalo",
    },
  };
}

export function createImageUpdate(params?: {
  messageId?: string;
  userId?: string;
  displayName?: string;
  chatId?: string;
  photoUrl?: string;
  date?: number;
}) {
  return {
    event_name: "message.image.received",
    message: {
      date: params?.date ?? 1774086023728,
      chat: { chat_type: "PRIVATE" as const, id: params?.chatId ?? "chat-123" },
      caption: "",
      message_id: params?.messageId ?? "msg-123",
      message_type: "CHAT_PHOTO",
      from: {
        id: params?.userId ?? "user-123",
        is_bot: false,
        display_name: params?.displayName ?? "Test User",
      },
      photo_url: params?.photoUrl ?? "https://example.com/test-image.jpg",
    },
  };
}

export function setLifecycleRuntimeCore(
  channel: NonNullable<NonNullable<Parameters<typeof createPluginRuntimeMock>[0]>["channel"]>,
) {
  getZaloRuntimeMock.mockReturnValue(
    createPluginRuntimeMock({
      channel,
    }),
  );
}

export function createImageLifecycleCore() {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const fetchRemoteMediaMock = vi.fn(async () => ({
    buffer: Buffer.from("image-bytes"),
    contentType: "image/jpeg",
  }));
  const saveMediaBufferMock = vi.fn(async () => ({
    path: "/tmp/zalo-photo.jpg",
    contentType: "image/jpeg",
  }));
  const core = createPluginRuntimeMock({
    channel: {
      media: {
        fetchRemoteMedia:
          fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
        saveMediaBuffer:
          saveMediaBufferMock as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
      },
      reply: {
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async () => undefined,
        ) as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      session: {
        recordInboundSession:
          recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"],
        resolveCommandAuthorizedFromAuthorizers: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"],
        isControlCommandMessage: vi.fn(
          () => false,
        ) as unknown as PluginRuntime["channel"]["commands"]["isControlCommandMessage"],
      },
    },
  });
  return {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock,
    fetchRemoteMediaMock,
    saveMediaBufferMock,
  };
}

export function expectImageLifecycleDelivery(params: {
  fetchRemoteMediaMock: ReturnType<typeof vi.fn>;
  saveMediaBufferMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  recordInboundSessionMock: ReturnType<typeof vi.fn>;
  photoUrl?: string;
  senderName?: string;
  mediaPath?: string;
  mediaType?: string;
}) {
  const photoUrl = params.photoUrl ?? "https://example.com/test-image.jpg";
  const senderName = params.senderName ?? "Test User";
  const mediaPath = params.mediaPath ?? "/tmp/zalo-photo.jpg";
  const mediaType = params.mediaType ?? "image/jpeg";
  expect(params.fetchRemoteMediaMock).toHaveBeenCalledWith({
    url: photoUrl,
    maxBytes: 5 * 1024 * 1024,
  });
  expect(params.saveMediaBufferMock).toHaveBeenCalledTimes(1);
  expect(params.finalizeInboundContextMock).toHaveBeenCalledWith(
    expect.objectContaining({
      SenderName: senderName,
      MediaPath: mediaPath,
      MediaType: mediaType,
    }),
  );
  expect(params.recordInboundSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ctx: expect.objectContaining({
        SenderName: senderName,
        MediaPath: mediaPath,
        MediaType: mediaType,
      }),
    }),
  );
}

export async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function postWebhookUpdate(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
}) {
  const url = new URL(params.path, params.baseUrl);
  const body = JSON.stringify(params.payload);
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-bot-api-secret-token": params.secret,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function postWebhookReplay(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
  settleBeforeReplay?: boolean;
}) {
  const first = await postWebhookUpdate(params);
  if (params.settleBeforeReplay) {
    await settleAsyncWork();
  }
  const replay = await postWebhookUpdate(params);
  return { first, replay };
}

export async function startWebhookLifecycleMonitor(params: {
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  token?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}) {
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const accountWebhookUrl =
    typeof params.account.config?.webhookUrl === "string"
      ? params.account.config.webhookUrl
      : undefined;
  const webhookUrl = params.webhookUrl ?? accountWebhookUrl;
  const webhookSecret =
    params.webhookSecret ?? normalizeSecretInputString(params.account.config?.webhookSecret);
  const run = monitorZaloProvider({
    token: params.token ?? "zalo-token",
    account: params.account,
    config: params.config,
    runtime,
    abortSignal: abort.signal,
    useWebhook: true,
    webhookUrl,
    webhookSecret,
  });

  await vi.waitFor(() => {
    if (setWebhookMock.mock.calls.length !== 1 || registry.httpRoutes.length !== 1) {
      throw new Error("waiting for webhook registration");
    }
  });

  const route = registry.httpRoutes[0];
  if (!route) {
    throw new Error("missing plugin HTTP route");
  }

  return {
    abort,
    registry,
    route,
    run,
    runtime,
    stop: async () => {
      abort.abort();
      await run;
    },
  };
}
