import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createAgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../../plugins/computer-use-contract.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  callGatewayTool,
  shouldUseInProcessGatewayTool,
  type GatewayCallOptions,
} from "./gateway.js";

export type GatewayComputerStatus =
  | { configured: false; available: false }
  | { configured: true; available: false; error?: string }
  | { configured: true; available: true; computerUse: ComputerUseCapabilityDescriptor };

export async function loadGatewayComputerStatus(
  options: GatewayCallOptions,
  signal?: AbortSignal,
): Promise<GatewayComputerStatus> {
  const result = await callGatewayTool<unknown>("computer.status", options, {}, { signal });
  if (!isRecord(result) || typeof result.configured !== "boolean") {
    throw new Error("COMPUTER_CONTRACT_MISMATCH: invalid Gateway computer status");
  }
  if (!result.configured) {
    return { configured: false, available: false };
  }
  if (result.available !== true) {
    return {
      configured: true,
      available: false,
      ...(typeof result.error === "string" ? { error: result.error } : {}),
    };
  }
  const computerUse = parseComputerUseCapabilityDescriptor(result.computerUse);
  return { configured: true, available: true, computerUse };
}

/** Capture a fixed native close while its run is admitted; cleanup cannot open another execution. */
export async function bindGatewayComputerCleanup(params: {
  options: GatewayCallOptions;
  generation: string;
  executionId: string;
}): Promise<((reason: string) => Promise<unknown>) | undefined> {
  const caller = getGatewayToolCallerIdentity();
  if (!shouldUseInProcessGatewayTool(params.options) || !caller?.operationalRunInstance) {
    return undefined;
  }
  const identity = await createAgentRuntimeIdentity({
    ...caller,
    operationalRunInstance: caller.operationalRunInstance,
  });
  if (!identity) {
    throw new Error("Gateway computer cleanup requires the admitted run identity");
  }
  const {
    bindAgentToolGatewayRequest,
    runWithGatewayToolCleanupContext,
    withAgentToolGatewayRuntimeIdentity,
  } = await import("./in-process-gateway.js");
  const request = runWithGatewayToolCleanupContext(
    () => bindAgentToolGatewayRequest({ resolveGatewayContext: caller.gatewayContextResolver }),
    caller.gatewayContextResolver,
  );
  return async (reason) => {
    const result = await request<{ payload: unknown }>(
      withAgentToolGatewayRuntimeIdentity(
        {
          method: "computer.invoke",
          params: {
            generation: params.generation,
            command: "computer.act",
            params: { action: "__close_execution", executionId: params.executionId, reason },
            idempotencyKey: `computer.close:${params.executionId}:gateway`,
          },
          timeoutMs: params.options.timeoutMs,
        },
        identity,
      ),
    );
    return result.payload;
  };
}
