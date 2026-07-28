import type { SystemAgentChatParams, SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const INVALID_CHAT_PARAMS_MESSAGE = "invalid openclaw.chat params";

function shouldRetryWithoutCapabilities(error: unknown, params: SystemAgentChatParams): boolean {
  return (
    params.capabilities?.qrCodePng === true &&
    error instanceof GatewayRequestError &&
    error.code === "INVALID_REQUEST" &&
    error.message.toLowerCase().includes(INVALID_CHAT_PARAMS_MESSAGE)
  );
}

export async function requestCustodianChat(params: {
  client: GatewayBrowserClient;
  request: SystemAgentChatParams;
  onSent: () => void;
}): Promise<SystemAgentChatResult> {
  const request: SystemAgentChatParams = {
    ...params.request,
    capabilities: { qrCodePng: true },
  };
  const options = {
    timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
    onSent: params.onSent,
  };
  try {
    return await params.client.request<SystemAgentChatResult>("openclaw.chat", request, options);
  } catch (error) {
    if (!shouldRetryWithoutCapabilities(error, request)) {
      throw error;
    }
    const legacyRequest = { ...request };
    delete legacyRequest.capabilities;
    return await params.client.request<SystemAgentChatResult>(
      "openclaw.chat",
      legacyRequest,
      options,
    );
  }
}
