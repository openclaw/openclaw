import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../utils/message-channel.js";

export type MessageActionGatewayOptions = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  mode?: GatewayClientMode;
};

let messageGatewayRuntimePromise: Promise<typeof import("./message.gateway.runtime.js")> | null =
  null;

function loadMessageGatewayRuntime() {
  if (!messageGatewayRuntimePromise) {
    messageGatewayRuntimePromise = import("./message.gateway.runtime.js").catch((err) => {
      messageGatewayRuntimePromise = null;
      throw err;
    });
  }
  return messageGatewayRuntimePromise;
}

function resolveGatewayActionOptions(gateway?: MessageActionGatewayOptions) {
  return {
    url: gateway?.url,
    token: gateway?.token,
    timeoutMs:
      typeof gateway?.timeoutMs === "number" && Number.isFinite(gateway.timeoutMs)
        ? Math.max(1, Math.floor(gateway.timeoutMs))
        : 10_000,
    clientName: gateway?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: gateway?.clientDisplayName,
    mode: gateway?.mode ?? GATEWAY_CLIENT_MODES.CLI,
  };
}

export async function callGatewayMessageAction<T>(params: {
  gateway?: MessageActionGatewayOptions;
  actionParams: Record<string, unknown>;
}): Promise<T> {
  const { callGatewayLeastPrivilege } = await loadMessageGatewayRuntime();
  const gateway = resolveGatewayActionOptions(params.gateway);
  return await callGatewayLeastPrivilege<T>({
    url: gateway.url,
    token: gateway.token,
    method: "message.action",
    params: params.actionParams,
    timeoutMs: gateway.timeoutMs,
    clientName: gateway.clientName,
    clientDisplayName: gateway.clientDisplayName,
    mode: gateway.mode,
  });
}

export async function resolveGatewayActionIdempotencyKey(idempotencyKey?: string): Promise<string> {
  if (idempotencyKey) {
    return idempotencyKey;
  }
  const { randomIdempotencyKey } = await loadMessageGatewayRuntime();
  return randomIdempotencyKey();
}
