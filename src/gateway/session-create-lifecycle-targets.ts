import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export function buildSessionCreateLifecycleTargets({
  target,
  targetLifecycleIdentities,
  canonicalParentSessionKey,
  parentSessionEntry,
  parentSessionTarget,
  holdParentLifecycle,
}: {
  target: GatewaySessionStoreTarget;
  targetLifecycleIdentities: string[];
  canonicalParentSessionKey: string | undefined;
  parentSessionEntry: SessionEntry | undefined;
  parentSessionTarget: GatewaySessionStoreTarget | undefined;
  holdParentLifecycle: boolean;
}) {
  const lifecycleTargets = [
    {
      scope: target.storePath,
      identities: targetLifecycleIdentities,
    },
  ];
  if (
    canonicalParentSessionKey &&
    parentSessionEntry?.sessionId &&
    parentSessionTarget &&
    holdParentLifecycle
  ) {
    lifecycleTargets.push({
      scope: parentSessionTarget.storePath,
      identities: [canonicalParentSessionKey, parentSessionEntry.sessionId],
    });
  }
  return lifecycleTargets;
}
