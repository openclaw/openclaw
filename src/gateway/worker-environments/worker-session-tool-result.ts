import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  isWorkerGatewayToolFrameWithinBudget,
  WorkerGatewayToolResultSchema,
  type WorkerGatewayToolInvokeResult,
} from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH } from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { SessionPortalToolSchema } from "../../agents/tools/portal-tool-contract.js";
import type {
  PlacedSessionsSpawnArguments,
  PlacedSessionsSendArguments,
} from "../../agents/tools/sessions-placement-tool-contract.js";
import { jsonResult } from "../../agents/tools/tool-results.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";

export type WorkerSessionToolRequest = {
  identity: WorkerConnectionIdentity;
  signal?: AbortSignal;
  onUpdate?: Parameters<AnyAgentTool["execute"]>[3];
} & (
  | { toolName: "sessions_spawn"; request: PlacedSessionsSpawnArguments & { toolCallId: string } }
  | { toolName: "sessions_send"; request: PlacedSessionsSendArguments & { toolCallId: string } }
  | { toolName: "portal"; request: Static<typeof SessionPortalToolSchema> & { toolCallId: string } }
);

export type WorkerSessionToolExecutor = (
  request: WorkerSessionToolRequest,
) => Promise<AgentToolResult<unknown>>;

export class WorkerSessionToolOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Worker session operation outcome is unknown; it was not replayed", { cause });
    this.name = "WorkerSessionToolOutcomeUnknownError";
  }
}

/** Retry only the same idempotent operation; callers revalidate authority on each attempt. */
export async function executeWorkerSessionToolWithReplay<T>(
  execute: (replay: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await execute(false);
  } catch {
    try {
      return await execute(true);
    } catch (error) {
      throw new WorkerSessionToolOutcomeUnknownError(error);
    }
  }
}

const MAX_WORKER_TOOL_ERROR_LENGTH = 1_024;

export function workerSessionToolErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "Worker session operation failed";
  return {
    ...jsonResult({
      status: "error",
      error: truncateUtf16Safe(message, MAX_WORKER_TOOL_ERROR_LENGTH),
    }),
    isError: true,
  };
}

export function serializeWorkerSessionToolError(error: unknown): string {
  return serializeWorkerSessionToolResult(workerSessionToolErrorResult(error));
}

function fitsWorkerToolResponse(result: WorkerGatewayToolInvokeResult): boolean {
  return isWorkerGatewayToolFrameWithinBudget(
    {
      type: "res",
      id: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH),
      ok: true,
      payload: result,
    },
    result,
  );
}

export function boundWorkerMcpRefusal(
  result: unknown,
  reason: string,
): WorkerGatewayToolInvokeResult {
  const mcpBlockedReason = truncateUtf16Safe(reason, MAX_WORKER_TOOL_ERROR_LENGTH);
  if (Value.Check(WorkerGatewayToolResultSchema, result)) {
    const denied = { ...result, mcpBlockedReason };
    if (fitsWorkerToolResponse(denied)) {
      return denied;
    }
  }
  // Even a large hook receipt must convey the trusted denial to the guest.
  return { ...workerSessionToolErrorResult(new Error(mcpBlockedReason)), mcpBlockedReason };
}

export function boundWorkerToolResult(
  result: unknown,
  mcpGuestResult?: unknown,
): WorkerGatewayToolInvokeResult {
  if (Value.Check(WorkerGatewayToolResultSchema, result)) {
    if (mcpGuestResult !== undefined) {
      const payload = { ...result, mcpGuestResult };
      if (fitsWorkerToolResponse(payload)) {
        return payload;
      }
    }
    // A large private snapshot must not hide an otherwise deliverable tool receipt.
    if (fitsWorkerToolResponse(result)) {
      return result;
    }
  }
  return workerSessionToolErrorResult(
    new Error("Worker tool result exceeded the transport contract"),
  );
}

export function serializeWorkerSessionToolResult(result: unknown): string {
  return JSON.stringify(boundWorkerToolResult(result));
}

export function parseWorkerSessionToolResult(resultJson: string): AgentToolResult<unknown> {
  const result: unknown = JSON.parse(resultJson);
  if (!Value.Check(WorkerGatewayToolResultSchema, result)) {
    throw new Error("Stored worker session tool result is invalid");
  }
  return { ...result, details: result.details };
}
