import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../../plugins/computer-use-contract.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

export type GatewayComputerStatus =
  | { configured: false; available: false }
  | {
      configured: true;
      available: false;
      computerUse?: ComputerUseCapabilityDescriptor;
      error?: string;
    }
  | { configured: true; available: true; computerUse: ComputerUseCapabilityDescriptor };

export async function loadGatewayComputerStatus(
  options: GatewayCallOptions,
  signal?: AbortSignal,
  probe = false,
): Promise<GatewayComputerStatus> {
  const result = await callGatewayTool<unknown>("computer.status", options, { probe }, { signal });
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
      ...(result.computerUse
        ? { computerUse: parseComputerUseCapabilityDescriptor(result.computerUse) }
        : {}),
      ...(typeof result.error === "string" ? { error: result.error } : {}),
    };
  }
  const computerUse = parseComputerUseCapabilityDescriptor(result.computerUse);
  return { configured: true, available: true, computerUse };
}
