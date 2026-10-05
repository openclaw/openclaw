import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../infra/node-commands.js";
import type { PendingSystemRunEvent } from "./node-registry.invoke-stream.js";
import { requiresNodeRepositoryReadiness } from "./node-runner-inventory-runtime.js";

export function nodeWorkspaceReadinessRequirement(command: string, params: unknown) {
  return {
    repositoryReadiness:
      command === NODE_WORKER_WORKSPACE_EXEC_COMMAND && requiresNodeRepositoryReadiness(params),
  };
}

export function prepareSystemRunInvokePayload(
  params: import("./node-invoke.types.js").NodeInvokeParams,
) {
  return normalizeSystemRunInvokeParams({ command: params.command, params: params.params });
}

export function resolvePendingSystemRunEvent(params: {
  command: string;
  params?: unknown;
}): PendingSystemRunEvent | undefined {
  const obj = asOptionalObjectRecord(params.params);
  if (params.command !== "system.run" || !obj) {
    return undefined;
  }
  const runId = normalizeOptionalString(obj.runId) ?? "";
  if (!runId) {
    return undefined;
  }
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  const sessionKey = normalizeOptionalString(obj.sessionKey) ?? "";
  return {
    runId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function normalizeSystemRunInvokeParams(params: {
  command: string;
  params?: unknown;
}): unknown {
  if (params.command !== "system.run" || !isRecord(params.params)) {
    return params.params;
  }
  const obj = params.params;
  const normalized: Record<string, unknown> = {
    ...obj,
    runId: normalizeOptionalString(obj.runId) || randomUUID(),
  };
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  if (timeoutMs === undefined) {
    delete normalized.timeoutMs;
  } else {
    normalized.timeoutMs = timeoutMs;
  }
  return normalized;
}

/** Normalize system.run timeout values, preserving null for no expiry. */
function normalizeSystemRunTimeoutMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const timeoutMs = Math.trunc(value);
  return timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 1) : null;
}
