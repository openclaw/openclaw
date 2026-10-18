import { z } from "zod";
import type { ClientToolDefinition } from "../agents/command/shared-types.js";

const UPDATE_REPAIR_MAINTENANCE_TOOL = "request_update_maintenance";
const requestSchema = z.strictObject({ operation: z.enum(["doctor-fix", "update-repair"]) });
export type UpdateRepairMaintenanceRequest = z.infer<typeof requestSchema>;

/** A terminal client tool requests work; it never runs maintenance inside the agent. */
export const updateRepairMaintenanceTool: ClientToolDefinition = {
  type: "function",
  function: {
    name: UPDATE_REPAIR_MAINTENANCE_TOOL,
    description:
      "End this repair turn and ask the update owner to run Doctor repair or finish an interrupted update after all agent database and process resources settle. Do not run these maintenance commands through exec. The owner preserves all lease, service, and capability refusals.",
    parameters: {
      type: "object",
      properties: { operation: { type: "string", enum: ["doctor-fix", "update-repair"] } },
      required: ["operation"],
      additionalProperties: false,
    },
    strict: true,
  },
};

export function readUpdateRepairMaintenanceRequest(meta: {
  stopReason?: string;
  pendingToolCalls?: Array<{ name: string; arguments: string }>;
}): UpdateRepairMaintenanceRequest | undefined {
  if (!meta.pendingToolCalls?.length) {
    return undefined;
  }
  const [call] = meta.pendingToolCalls;
  if (
    meta.stopReason !== "tool_calls" ||
    meta.pendingToolCalls.length !== 1 ||
    call?.name !== UPDATE_REPAIR_MAINTENANCE_TOOL
  ) {
    throw new Error("Repair returned an invalid maintenance handoff.");
  }
  return requestSchema.parse(JSON.parse(call.arguments));
}
