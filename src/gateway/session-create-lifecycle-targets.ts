import type { SessionEntry } from "../config/sessions/types.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export function buildSessionCreateLifecycleTargets({
  target,
  targetSessionId,
  targetLifecycleIdentities,
  canonicalParentSessionKey,
  parentSessionEntry,
  parentSessionTarget,
  holdParentLifecycle,
}: {
  target: GatewaySessionStoreTarget;
  targetSessionId: string | undefined;
  targetLifecycleIdentities: string[];
  canonicalParentSessionKey: string | undefined;
  parentSessionEntry: SessionEntry | undefined;
  parentSessionTarget: GatewaySessionStoreTarget | undefined;
  holdParentLifecycle: boolean;
}) {
  const lifecycleTargets = [
    captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: target.canonicalKey,
      aliases: targetLifecycleIdentities,
      agentId: target.agentId,
      incarnation: targetSessionId,
    }),
  ];
  if (
    canonicalParentSessionKey &&
    parentSessionEntry?.sessionId &&
    parentSessionTarget &&
    holdParentLifecycle
  ) {
    lifecycleTargets.push(
      captureSessionTarget({
        storeScope: parentSessionTarget.storePath,
        sessionKey: canonicalParentSessionKey,
        aliases: parentSessionTarget.storeKeys,
        incarnation: parentSessionEntry.sessionId,
        agentId: parentSessionTarget.agentId,
      }),
    );
  }
  return lifecycleTargets;
}
