import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveActiveEmbeddedRunOwnerByRunId,
  type ActiveEmbeddedRunOwner,
} from "../../agents/embedded-agent-runner/runs.js";
import type { GatewayRequestHandlers } from "./types.js";

export function resolveOwnedActiveTalkClientInjectionTarget(params: {
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
  clientConnId?: string;
  sessionKey: string;
}): ActiveEmbeddedRunOwner | undefined {
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return undefined;
  }
  for (const [runId, entry] of params.context.chatAbortControllers) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      const target = resolveActiveEmbeddedRunOwnerByRunId(runId);
      if (target?.sessionId === entry.sessionId) {
        return target;
      }
    }
  }
  return undefined;
}
