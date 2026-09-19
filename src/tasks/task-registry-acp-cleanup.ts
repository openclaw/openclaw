import {
  acpSessionActorKey,
  resolveAcpAgentFromSessionKey,
  resolveAcpSessionTarget,
} from "../acp/control-plane/manager.utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type CloseAcpSession = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: string;
}) => Promise<void>;

export async function loadTaskAcpSessionCloser(): Promise<CloseAcpSession> {
  const { getAcpSessionManager } = await import("../acp/control-plane/manager.js");
  return async ({ cfg, sessionKey, agentId, reason }) => {
    await getAcpSessionManager().closeSession({
      cfg,
      sessionKey,
      agentId,
      reason,
      discardPersistentState: true,
      clearMeta: true,
      allowBackendUnavailable: true,
      requireAcpSession: false,
    });
  };
}

const MAX_TRACKED_ACP_FAILURES = 1000;
const acpMaintenanceFailureSignatures = new Map<string, string>();

function getAcpMaintenanceErrorSignature(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const parts: string[] = [];
  if ("name" in error && typeof error.name === "string" && error.name) {
    parts.push(error.name);
  }
  if ("code" in error && typeof error.code === "string" && error.code) {
    parts.push(error.code);
  }
  if ("detailCode" in error && typeof error.detailCode === "string" && error.detailCode) {
    parts.push(error.detailCode);
  }
  if ("message" in error && typeof error.message === "string" && error.message) {
    parts.push(error.message);
  }
  if (parts.length > 0) {
    return parts.join(":");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "[object Object]";
  }
}

function recordAcpMaintenanceFailureWarning(params: {
  actorKey: string;
  action: "close" | "unbind";
  error: unknown;
}): boolean {
  const mapKey = `${params.actorKey}:${params.action}`;
  const signature = getAcpMaintenanceErrorSignature(params.error);
  const previous = acpMaintenanceFailureSignatures.get(mapKey);
  if (previous === signature) {
    return false;
  }
  if (acpMaintenanceFailureSignatures.size >= MAX_TRACKED_ACP_FAILURES) {
    const oldest = acpMaintenanceFailureSignatures.keys().next().value;
    if (oldest !== undefined) {
      acpMaintenanceFailureSignatures.delete(oldest);
    }
  }
  acpMaintenanceFailureSignatures.set(mapKey, signature);
  return true;
}

function clearAcpMaintenanceFailureWarning(actorKey: string, action: "close" | "unbind"): void {
  acpMaintenanceFailureSignatures.delete(`${actorKey}:${action}`);
}

export function resetAcpMaintenanceWarningCoalescingForTesting(): void {
  acpMaintenanceFailureSignatures.clear();
}

export function resolveAcpSessionActorKeySafe(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): string {
  try {
    return acpSessionActorKey(resolveAcpSessionTarget(params));
  } catch {
    return `session:${params.sessionKey.trim().toLowerCase()}:agent:${(params.agentId ?? "main").trim().toLowerCase()}`;
  }
}

export async function closeAndUnbindAcpSessionWithDiagnostics(params: {
  action: "terminal" | "orphaned";
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  closeAgentId?: string;
  taskId?: string;
  closeAcpSession?: CloseAcpSession;
  unbindSessionBindings?: (params: {
    targetSessionKey: string;
    reason: string;
  }) => Promise<unknown>;
  logWarn: (message: string, meta: Record<string, unknown>) => void;
}): Promise<boolean> {
  const actorKey = resolveAcpSessionActorKeySafe({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const resolvedAgentId = params.agentId ?? resolveAcpAgentFromSessionKey(params.sessionKey);
  const reason =
    params.action === "terminal" ? "terminal-task-cleanup" : "orphaned-parent-task-cleanup";
  if (params.closeAcpSession) {
    try {
      await params.closeAcpSession({
        cfg: params.cfg,
        agentId: params.closeAgentId,
        sessionKey: params.sessionKey,
        reason,
      });
      clearAcpMaintenanceFailureWarning(actorKey, "close");
    } catch (error) {
      if (recordAcpMaintenanceFailureWarning({ actorKey, action: "close", error })) {
        params.logWarn(
          params.action === "terminal"
            ? "Failed to close terminal ACP session during task maintenance"
            : "Failed to close orphaned parent-owned ACP session during task maintenance",
          {
            sessionKey: params.sessionKey,
            agentId: resolvedAgentId,
            ...(params.taskId ? { taskId: params.taskId } : {}),
            error,
          },
        );
      }
      return false;
    }
  }
  if (params.unbindSessionBindings) {
    try {
      await params.unbindSessionBindings({
        targetSessionKey: params.sessionKey,
        reason,
      });
      clearAcpMaintenanceFailureWarning(actorKey, "unbind");
    } catch (error) {
      if (recordAcpMaintenanceFailureWarning({ actorKey, action: "unbind", error })) {
        params.logWarn(
          params.action === "terminal"
            ? "Failed to unbind terminal ACP session during task maintenance"
            : "Failed to unbind orphaned parent-owned ACP session during task maintenance",
          {
            sessionKey: params.sessionKey,
            agentId: resolvedAgentId,
            ...(params.taskId ? { taskId: params.taskId } : {}),
            error,
          },
        );
      }
    }
  }
  return true;
}
