// Gateway operator-approvals client helper.
// Connects a backend Gateway client scoped to operator approval events.
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginApprovalExternalResolutionDecision } from "../infra/plugin-approvals.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { getOperatorApprovalRuntimeToken } from "./operator-approval-runtime-token.js";

function shouldSendApprovalRuntimeToken(urlSource: string): boolean {
  // This token is process-local authority; loopback alone may be a tunnel or another gateway.
  return (
    urlSource === "local loopback" || urlSource === "missing gateway.remote.url (fallback local)"
  );
}

function shouldOmitApprovalRuntimeDeviceIdentity(params: {
  sendsApprovalRuntimeToken: boolean;
}): boolean {
  return params.sendsApprovalRuntimeToken;
}

type OperatorGatewayClientFactoryParams = Pick<
  GatewayClientOptions,
  "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk" | "onReconnectPaused"
> & {
  config: OpenClawConfig;
  gatewayUrl?: string;
};

async function createOperatorScopedGatewayClient(
  params: OperatorGatewayClientFactoryParams & {
    scope: "operator.approvals";
    approvalRuntimeTokenMode?: "approval-local";
  },
): Promise<GatewayClient> {
  const bootstrap = await resolveGatewayClientBootstrap({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    env: process.env,
  });
  const sendsApprovalRuntimeToken =
    params.approvalRuntimeTokenMode === "approval-local" &&
    shouldSendApprovalRuntimeToken(bootstrap.urlSource);

  return new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    ...(sendsApprovalRuntimeToken
      ? { approvalRuntimeToken: getOperatorApprovalRuntimeToken() }
      : {}),
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: params.clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: [params.scope],
    deviceIdentity: shouldOmitApprovalRuntimeDeviceIdentity({
      sendsApprovalRuntimeToken,
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

/** Create a Gateway client authorized for operator approval event handling. */
export async function createOperatorApprovalsGatewayClient(
  params: OperatorGatewayClientFactoryParams,
): Promise<GatewayClient> {
  return await createOperatorScopedGatewayClient({
    ...params,
    scope: "operator.approvals",
    approvalRuntimeTokenMode: "approval-local",
  });
}

async function withOperatorScopedGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
  createClient: (params: OperatorGatewayClientFactoryParams) => Promise<GatewayClient>,
  readinessLabel: string,
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

  const gatewayClient = await createClient({
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
          ? `gateway ${readinessLabel} client start aborted before readiness`
          : `gateway readiness unavailable before ${readinessLabel} client start`,
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

export async function withOperatorApprovalsGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  return await withOperatorScopedGatewayClient(
    params,
    run,
    createOperatorApprovalsGatewayClient,
    "approval",
  );
}

export type ResolveVerifiedPluginApprovalOverGatewayParams = {
  config: OpenClawConfig;
  gatewayUrl?: string;
  clientDisplayName?: string;
  approvalId: string;
  decision: PluginApprovalExternalResolutionDecision;
  pluginId: string;
};

export async function resolveVerifiedPluginApprovalOverGateway(
  params: ResolveVerifiedPluginApprovalOverGatewayParams,
): Promise<void> {
  await withOperatorApprovalsGatewayClient(
    {
      config: params.config,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: params.clientDisplayName ?? "Verified plugin approval",
    },
    async (client) => {
      await client.request("plugin.approval.resolveVerified", {
        id: params.approvalId,
        decision: params.decision,
        pluginId: params.pluginId,
      });
    },
  );
}
