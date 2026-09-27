import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  WorkerPortalParams,
  WorkerSessionsSendParams,
  WorkerSessionsSpawnParams,
  WorkerSessionToolResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import type { WorkerSkillWorkshopParams } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import { jsonResult } from "../../agents/tools/tool-results.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";

export type WorkerSessionToolRequest = {
  identity: WorkerConnectionIdentity;
  signal?: AbortSignal;
} & (
  | { toolName: "sessions_spawn"; request: WorkerSessionsSpawnParams }
  | { toolName: "sessions_send"; request: WorkerSessionsSendParams }
  | { toolName: "portal"; request: WorkerPortalParams }
  | { toolName: "skill_workshop"; request: WorkerSkillWorkshopParams }
);

export type WorkerSessionToolExecutor = (
  request: WorkerSessionToolRequest,
) => Promise<WorkerSessionToolResult>;

export class WorkerSessionToolOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Worker session operation outcome is unknown; it was not replayed", { cause });
    this.name = "WorkerSessionToolOutcomeUnknownError";
  }
}

export function workerSessionToolErrorResult(error: unknown) {
  const message = redactSensitiveText(
    error instanceof Error ? error.message : "Worker session operation failed",
    { mode: "tools" },
  );
  return jsonResult({
    status: "error",
    error: truncateUtf16Safe(message, 1_024),
  });
}

export function serializeWorkerSessionToolResult(result: unknown): string {
  const resultJson = JSON.stringify(result);
  const frameBytes = Buffer.byteLength(
    JSON.stringify({
      type: "res",
      id: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH),
      ok: true,
      payload: { resultJson },
    }),
    "utf8",
  );
  if (frameBytes > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
    return JSON.stringify(
      workerSessionToolErrorResult(new Error("Worker session tool result exceeded the limit")),
    );
  }
  return resultJson;
}
