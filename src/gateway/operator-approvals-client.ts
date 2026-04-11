import type { OpenClawConfig } from "../config/config.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  resolveGatewayClientBootstrap,
  resolveGatewayUrlOverrideSource,
} from "./client-bootstrap.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function createOperatorApprovalsGatewayClient(
  params: Pick<
    GatewayClientOptions,
    "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk"
  > & {
    config: OpenClawConfig;
    gatewayUrl?: string;
  },
): Promise<GatewayClient> {
  const bootstrap = await resolveGatewayClientBootstrap({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    env: process.env,
  });

  const gatewayUrlOverrideSource = resolveGatewayUrlOverrideSource(bootstrap.urlSource);
  const isRemoteMode = params.config.gateway?.mode === "remote";
  const remoteUrl = isRemoteMode ? trimToUndefined(params.config.gateway?.remote?.url) : undefined;
  const useLocalTls =
    params.config.gateway?.tls?.enabled === true &&
    !gatewayUrlOverrideSource &&
    !remoteUrl &&
    bootstrap.url.startsWith("wss://");
  const tlsRuntime = useLocalTls
    ? await loadGatewayTlsRuntime(params.config.gateway?.tls)
    : undefined;
  const remoteTlsFingerprint =
    // Env overrides may still inherit configured remote TLS pinning for private cert deployments.
    // CLI overrides remain explicit-only and intentionally skip config remote TLS to avoid
    // accidentally pinning against caller-supplied target URLs.
    isRemoteMode && gatewayUrlOverrideSource !== "cli"
      ? trimToUndefined(params.config.gateway?.remote?.tlsFingerprint)
      : undefined;
  const tlsFingerprint =
    remoteTlsFingerprint || (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined);

  return new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    tlsFingerprint,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: params.clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.approvals"],
    onEvent: params.onEvent,
    onHelloOk: params.onHelloOk,
    onConnectError: params.onConnectError,
    onClose: params.onClose,
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

  const gatewayClient = await createOperatorApprovalsGatewayClient({
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
    gatewayClient.start();
    await ready;
    return await run(gatewayClient);
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}
