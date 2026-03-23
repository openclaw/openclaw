import { vi } from "vitest";
import type { ResolvedZaloAccount } from "../../../extensions/zalo/src/accounts.js";
import {
  clearZaloWebhookSecurityStateForTest,
  monitorZaloProvider,
} from "../../../extensions/zalo/src/monitor.js";
import type { OpenClawConfig } from "../../../extensions/zalo/src/runtime-api.js";
import { normalizeSecretInputString } from "../../../extensions/zalo/src/secret-input.js";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { withServer } from "../http-test-server.js";
import { createRuntimeEnv } from "./runtime-env.js";

export { withServer };

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

vi.mock("../../../extensions/zalo/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../extensions/zalo/src/api.js")>();
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

vi.mock("../../../extensions/zalo/src/runtime.js", () => ({
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
  return await fetch(`${params.baseUrl}${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bot-api-secret-token": params.secret,
    },
    body: JSON.stringify(params.payload),
  });
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
  const webhookUrl = params.webhookUrl ?? params.account.config?.webhookUrl;
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
  };
}
