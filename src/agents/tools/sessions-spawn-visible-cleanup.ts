import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { deleteSubagentSessionForCleanup } from "../subagents/registry/subagent-session-cleanup.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

const log = createSubsystemLogger("agents/sessions");

export function summarizeVisibleSessionSpawnError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return isRecord(error) && typeof error.message === "string" ? error.message : "error";
}

export async function cleanupVisibleSpawnSession(params: {
  callGateway: InProcessGatewayCaller;
  childSessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): Promise<string> {
  const outcome = await deleteSubagentSessionForCleanup({
    callGateway: ({ method, params: cleanupParams, timeoutMs }) =>
      params.callGateway(method, cleanupParams, { timeoutMs }),
    childSessionKey: params.childSessionKey,
    expectedSessionId: params.expectedSessionId,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
    emitLifecycleHooks: false,
    onError: (error) => log.warn(`visible session cleanup failed: ${formatErrorMessage(error)}`),
  });
  return outcome === "deleted"
    ? "Session removed."
    : outcome === "changed"
      ? "Session changed; newer session kept."
      : "Session cleanup unconfirmed. Inspect the child session before retrying.";
}
