import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isLoopbackIpAddress } from "../shared/net/ip.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { getOperatorApprovalRuntimeToken } from "./operator-approval-runtime-token.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./protocol/client-info.js";

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

function shouldOmitOperatorApprovalDeviceIdentity(params: {
  url: string;
  token?: string;
  password?: string;
}): boolean {
  return Boolean((params.token || params.password) && isLoopbackGatewayUrl(params.url));
}

type OperatorScopedGatewayClientParams = Pick<
  GatewayClientOptions,
  "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk" | "onReconnectPaused"
> & {
  config: OpenClawConfig;
  gatewayUrl?: string;
  scopes: NonNullable<GatewayClientOptions["scopes"]>;
};

type OperatorScopedGatewayCallbackParams = {
  config: OpenClawConfig;
  gatewayUrl?: string;
  clientDisplayName: string;
  scopes: NonNullable<GatewayClientOptions["scopes"]>;
};

async function createOperatorScopedGatewayClient(
  params: OperatorScopedGatewayClientParams,
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
    ...(params.gatewayUrl ? {} : { approvalRuntimeToken: getOperatorApprovalRuntimeToken() }),
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: params.clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: params.scopes,
    deviceIdentity: shouldOmitOperatorApprovalDeviceIdentity({
      url: bootstrap.url,
      token: bootstrap.auth.token,
      password: bootstrap.auth.password,
    })
      ? null
      : undefined,
    onEvent: params.onEvent,
    onHelloOk: params.onHelloOk,
    onConnectError: params.onConnectError,
    onReconnectPaused: params.onReconnectPaused,
    onClose: params.onClose,
  });
}

async function withOperatorScopedGatewayClient<T>(
  params: OperatorScopedGatewayCallbackParams,
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

  const gatewayClient = await createOperatorScopedGatewayClient({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: params.clientDisplayName,
    scopes: params.scopes,
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
          ? "gateway approval client start aborted before readiness"
          : "gateway readiness unavailable before approval client start",
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

export async function createOperatorApprovalsGatewayClient(
  params: Pick<
    GatewayClientOptions,
    | "clientDisplayName"
    | "onClose"
    | "onConnectError"
    | "onEvent"
    | "onHelloOk"
    | "onReconnectPaused"
  > & {
    config: OpenClawConfig;
    gatewayUrl?: string;
  },
): Promise<GatewayClient> {
  return createOperatorScopedGatewayClient({
    ...params,
    scopes: ["operator.approvals"],
  });
}

export async function withOperatorApprovalsGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  return withOperatorScopedGatewayClient(
    {
      ...params,
      scopes: ["operator.approvals"],
    },
    run,
  );
}

export async function createOperatorAdminGatewayClient(
  params: Pick<
    GatewayClientOptions,
    | "clientDisplayName"
    | "onClose"
    | "onConnectError"
    | "onEvent"
    | "onHelloOk"
    | "onReconnectPaused"
  > & {
    config: OpenClawConfig;
    gatewayUrl?: string;
  },
): Promise<GatewayClient> {
  return createOperatorScopedGatewayClient({
    ...params,
    scopes: ["operator.admin"],
  });
}

export async function withOperatorAdminGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  return withOperatorScopedGatewayClient(
    {
      ...params,
      scopes: ["operator.admin"],
    },
    run,
  );
}
