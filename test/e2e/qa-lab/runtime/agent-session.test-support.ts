import type { createQaGatewayChild, QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient, GatewayClientOptions } from "../../../../src/gateway/client.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";

export function connectOperator(
  gateway: QaGatewayChild,
  clientDisplayName: string,
  callbacks: Pick<GatewayClientOptions, "onEvent"> = {},
): Promise<GatewayClient> {
  return acquireGatewayTestClient(
    {
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName,
      clientVersion: "1.0.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: null,
      requestTimeoutMs: 20_000,
      ...callbacks,
    },
    {
      timeoutMs: 20_000,
      timeoutMessage: `Gateway client connection timed out:\n${gateway.logs()}`,
      closeMessage: "Gateway closed",
      unrefTimeout: true,
    },
  );
}

export function startSessionGateway(
  owner: ReturnType<typeof createQaGatewayChild>,
  providerBaseUrl: string,
  options: Partial<Parameters<typeof owner.start>[0]> = {},
) {
  return owner.start({
    repoRoot: process.cwd(),
    providerBaseUrl: `${providerBaseUrl}/v1`,
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna",
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
    fastMode: true,
    runtimeEnvPatch: { OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_TEST_MINIMAL_GATEWAY: "1" },
    mutateConfig: (config) => ({ ...config, plugins: { enabled: false } }),
    ...options,
  });
}

export function messageRole(message: unknown): string | undefined {
  const role = message && typeof message === "object" ? (message as { role?: unknown }).role : null;
  return typeof role === "string" ? role : undefined;
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}
