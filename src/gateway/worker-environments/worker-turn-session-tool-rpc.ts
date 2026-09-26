import { Value } from "typebox/value";
import {
  WorkerPortalParamsSchema,
  WorkerPresenceParamsSchema,
  WorkerSessionsSendParamsSchema,
  WorkerSessionsSpawnParamsSchema,
  type WorkerProtocolCloseReason,
  type WorkerSessionToolResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WorkerSkillWorkshopParamsSchema } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import type { WorkerSessionToolName } from "../../worker/tool-authority.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  serializeWorkerSessionToolResult,
  workerSessionToolErrorResult,
  type WorkerSessionToolExecutor,
  type WorkerSessionToolRequest,
} from "./worker-session-tool-result.js";

type WorkerSessionToolAdmission =
  | { ok: true }
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerSessionToolServiceResult =
  | { ok: true; result: WorkerSessionToolResult }
  | { ok: false; closeReason: WorkerProtocolCloseReason }
  | { ok: false; reason: WorkerProtocolCloseReason };

export function createWorkerSessionToolRpc(options: {
  execute?: WorkerSessionToolExecutor;
  validate(
    identity: WorkerConnectionIdentity,
    toolName: WorkerSessionToolName,
  ): WorkerSessionToolAdmission;
}) {
  return async (
    identity: WorkerConnectionIdentity,
    toolName: WorkerSessionToolName,
    request: WorkerSessionToolRequest["request"],
    signal?: AbortSignal,
  ): Promise<WorkerSessionToolServiceResult> => {
    const validate = () => options.validate(identity, toolName);
    const admitted = validate();
    if (!admitted.ok) {
      return admitted;
    }
    if (!options.execute) {
      return { ok: false, reason: "gateway-unavailable" };
    }
    const operation =
      toolName === "skill_workshop" && Value.Check(WorkerSkillWorkshopParamsSchema, request)
        ? { toolName, request }
        : toolName === "sessions_spawn" && Value.Check(WorkerSessionsSpawnParamsSchema, request)
          ? { toolName, request }
          : toolName === "sessions_send" && Value.Check(WorkerSessionsSendParamsSchema, request)
            ? { toolName, request }
            : toolName === "portal" && Value.Check(WorkerPortalParamsSchema, request)
              ? { toolName, request }
              : toolName === "presence" && Value.Check(WorkerPresenceParamsSchema, request)
                ? { toolName, request }
                : undefined;
    if (!operation) {
      return { ok: false, closeReason: "invalid-frame" };
    }
    let result: WorkerSessionToolResult;
    try {
      result = await options.execute({
        identity,
        ...operation,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      result = {
        resultJson: serializeWorkerSessionToolResult(workerSessionToolErrorResult(error)),
      };
    }
    // The tool may have awaited provider provisioning or another session turn.
    // Neither success nor failure may return after the source turn or placement was revoked.
    const current = validate();
    return current.ok ? { ok: true, result } : current;
  };
}
