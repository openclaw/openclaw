import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isLoopbackIpAddress } from "../shared/net/ip.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./protocol/client-info.js";

type OperatorChatGatewayClientFactoryParams = Pick<
  GatewayClientOptions,
  "clientDisplayName" | "onClose" | "onConnectError" | "onHelloOk" | "onReconnectPaused"
> & {
  config: OpenClawConfig;
  gatewayUrl?: string;
};

export type InjectChatMessageOverGatewayParams = {
  config: OpenClawConfig;
  gatewayUrl?: string;
  clientDisplayName?: string;
  sessionKey: string;
  message: string;
  label?: string;
  idempotencyKey?: string;
  command?: boolean;
  interactive?: Record<string, unknown>;
  channelData?: Record<string, unknown>;
};

export type InjectChatMessageOverGatewayResult =
  | {
      ok: true;
      messageId: string;
    }
  | {
      ok: true;
      deduped: true;
    };

function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

function shouldOmitOperatorChatDeviceIdentity(params: {
  url: string;
  token?: string;
  password?: string;
}): boolean {
  return Boolean((params.token || params.password) && isLoopbackGatewayUrl(params.url));
}

async function createOperatorChatGatewayClient(
  params: OperatorChatGatewayClientFactoryParams,
): Promise<GatewayClient> {
  const bootstrap = await resolveGatewayClientBootstrap({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    env: process.env,
  });

  return new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: params.clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.admin"],
    deviceIdentity: shouldOmitOperatorChatDeviceIdentity({
      url: bootstrap.url,
      token: bootstrap.auth.token,
      password: bootstrap.auth.password,
    })
      ? null
      : undefined,
    onHelloOk: params.onHelloOk,
    onConnectError: params.onConnectError,
    onReconnectPaused: params.onReconnectPaused,
    onClose: params.onClose,
  });
}

async function withOperatorChatGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady();
  };
  const failReady = (err: unknown) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(err);
  };

  const gatewayClient = await createOperatorChatGatewayClient({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: params.clientDisplayName,
    onHelloOk: () => {
      markReady();
    },
    onConnectError: (err) => {
      failReady(err);
    },
    onClose: (code, reason) => {
      failReady(new Error(`gateway closed (${code}): ${reason}`));
    },
  });

  try {
    const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, {
      clientOptions: { preauthHandshakeTimeoutMs: params.config.gateway?.handshakeTimeoutMs },
    });
    if (!readiness.ready) {
      throw new Error(
        readiness.aborted
          ? "gateway chat injection client start aborted before readiness"
          : "gateway readiness unavailable before chat injection client start",
      );
    }
    await ready;
    return await run(gatewayClient);
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}

function normalizeChatInjectResult(raw: unknown): InjectChatMessageOverGatewayResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Gateway chat.inject returned an invalid response.");
  }
  const record = raw as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error("Gateway chat.inject returned an invalid response.");
  }
  if (record.deduped === true) {
    return { ok: true, deduped: true };
  }
  if (typeof record.messageId === "string" && record.messageId.length > 0) {
    return { ok: true, messageId: record.messageId };
  }
  throw new Error("Gateway chat.inject returned an invalid response.");
}

export async function injectChatMessageOverGateway(
  params: InjectChatMessageOverGatewayParams,
): Promise<InjectChatMessageOverGatewayResult> {
  return await withOperatorChatGatewayClient(
    {
      config: params.config,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: params.clientDisplayName ?? "Plugin chat injection",
    },
    async (client) => {
      const raw = await client.request("chat.inject", {
        sessionKey: params.sessionKey,
        message: params.message,
        ...(params.label !== undefined ? { label: params.label } : {}),
        ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
        ...(params.command !== undefined ? { command: params.command } : {}),
        ...(params.interactive !== undefined ? { interactive: params.interactive } : {}),
        ...(params.channelData !== undefined ? { channelData: params.channelData } : {}),
      });
      return normalizeChatInjectResult(raw);
    },
  );
}
