import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { SecretsResolveResult } from "../../packages/gateway-protocol/src/schema/secrets.js";
import { bindAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";

export function isAllowedPathsSecretsResolveCompatError(err: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  if (!message.includes("secrets.resolve")) {
    return false;
  }
  return message.includes("invalid request") || message.includes("invalid secrets.resolve params");
}

export async function callGatewaySecretsResolve(
  params: Parameters<typeof resolveCommandSecretRefsViaGateway>[0],
): Promise<SecretsResolveResult> {
  const callGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const request = {
    config: params.config,
    method: "secrets.resolve",
    requiredMethods: ["secrets.resolve"],
    params: {
      commandName: params.commandName,
      targetIds: [...params.targetIds],
      ...(params.allowedPaths ? { allowedPaths: [...params.allowedPaths] } : {}),
      ...(params.forcedActivePaths ? { forcedActivePaths: [...params.forcedActivePaths] } : {}),
      ...(params.optionalActivePaths
        ? { optionalActivePaths: [...params.optionalActivePaths] }
        : {}),
    },
    timeoutMs: params.gatewaySecretResolveTimeoutMs ?? 30_000,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  };
  try {
    return await callGateway(request);
  } catch (err) {
    if (
      (!params.allowedPaths && !params.forcedActivePaths && !params.optionalActivePaths) ||
      Boolean(params.forcedActivePaths?.size) ||
      !isAllowedPathsSecretsResolveCompatError(err)
    ) {
      throw err;
    }
    return callGateway({
      ...request,
      params: {
        commandName: params.commandName,
        targetIds: [...params.targetIds],
      },
    });
  }
}
