import { getSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import { captureSessionPortalTarget } from "../../gateway/worker-environments/session-portal-target.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

export type SessionPortalToolTarget = {
  sessionKey: string;
  agentId: string;
  environmentId: string;
  assertCurrent(): void;
};

/** Availability uses resident execution facts; the scoped RPC still authorizes every call. */
export function prepareSessionPortalToolTarget(input: {
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
}): SessionPortalToolTarget | undefined {
  if (!input.sessionId || !input.sessionKey || !input.agentId) {
    return undefined;
  }
  const context = getInProcessGatewayToolContext();
  const environments = context?.workerEnvironmentService;
  const projection = getSessionRowProjection(context);
  const row = projection?.sharingTarget({ agentId: input.agentId, key: input.sessionKey });
  const record = row && {
    agentId: row.agentId,
    sessionKey: row.canonicalKey,
    sessionId: row.entry.sessionId,
    sessionLifecycleRevision: row.entry.lifecycleRevision,
  };
  if (
    !context?.portalService ||
    !environments ||
    !record ||
    record.sessionKey !== input.sessionKey ||
    record.agentId !== input.agentId ||
    record.sessionId !== input.sessionId ||
    row?.entry.modelSelectionLocked === true
  ) {
    return undefined;
  }
  try {
    const target = captureSessionPortalTarget(environments, record);
    return {
      sessionKey: record.sessionKey,
      agentId: record.agentId,
      environmentId: target.binding.environmentId,
      assertCurrent: () => {
        if (getInProcessGatewayToolContext() !== context) {
          throw new Error("Session preview belongs to a different or retired Gateway");
        }
        const current = projection?.sharingTarget({
          agentId: record.agentId,
          key: record.sessionKey,
        });
        if (
          !current ||
          current.entry.sessionId !== record.sessionId ||
          current.entry.lifecycleRevision !== record.sessionLifecycleRevision ||
          current.entry.modelSelectionLocked === true
        ) {
          throw new Error("Conversation preview policy or session identity changed");
        }
        target.assertCurrent();
      },
    };
  } catch {
    return undefined;
  }
}
