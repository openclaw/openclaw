import { z } from "zod";
import type { ClientToolDefinition } from "../agents/command/shared-types.js";
import { recordAgentCleanupFailure } from "../agents/run-cleanup-timeout.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { UpdateRepairTarget } from "./update-repair-protocol.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

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

/** Called only after inference, the agent turn, and their resource scopes have closed. */
export async function runUpdateRepairMaintenance(params: {
  request: UpdateRepairMaintenanceRequest;
  target: UpdateRepairTarget;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  allowGatewayActivation: boolean;
}) {
  const [{ resolveGatewayInstallEntrypoint }, { isNodeRuntime }, { runUtf8CommandWithTimeout }] =
    await Promise.all([
      import("../daemon/gateway-entrypoint.js"),
      import("../daemon/runtime-binary.js"),
      import("../process/exec.js"),
    ]);
  const entrypoint = await resolveGatewayInstallEntrypoint(params.target.installRoot);
  params.signal.throwIfAborted();
  params.assertCurrent();
  if (!entrypoint) {
    throw new Error("The installed OpenClaw entrypoint is unavailable.");
  }
  const args =
    params.request.operation === "update-repair"
      ? [
          "update",
          "repair",
          "--yes",
          "--json",
          ...(params.allowGatewayActivation ? [] : ["--no-restart"]),
        ]
      : ["doctor", "--fix", "--non-interactive"];
  try {
    const result = await runUtf8CommandWithTimeout(
      [isNodeRuntime(process.execPath) ? process.execPath : "node", entrypoint, ...args],
      {
        cwd: params.target.installRoot,
        baseEnv: {},
        // The fixing subtree must not recursively start another automatic repair.
        env: {
          ...params.env,
          // Preserve an intentional stop; otherwise let the command's existing
          // maintenance owner enforce its native service and activation policy.
          ...(!params.allowGatewayActivation
            ? buildUpdateDoctorEnv({
                allowGatewayServiceRepair: false,
                allowGatewayActivation: false,
                serviceRepairPolicy: "external",
              })
            : {}),
          OPENCLAW_SHELL: "exec",
        },
        input: "",
        signal: params.signal,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        outputCapture: "tail",
        maxOutputBytes: 32 * 1024,
      },
    );
    if (result.cleanup === "uncertain" || result.cleanup === "forced") {
      recordAgentCleanupFailure();
      throw new Error("Maintenance subprocess cleanup is unconfirmed.");
    }
    return result;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      recordAgentCleanupFailure();
    }
    throw error;
  }
}
