import { parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";

let revision = 0;
const accessChangeListeners = new Set<(sessionKeys: readonly string[] | undefined) => void>();

/**
 * Marks Gateway access decisions stale across asynchronously yielded reads.
 * `sessionKeys` names the only sessions a change can affect; omit it when the scope is unknown.
 */
export function bumpGatewayAccessRevision(sessionKeys?: readonly string[]): void {
  revision += 1;
  notifyListeners(accessChangeListeners, sessionKeys?.length ? sessionKeys : undefined);
}

export function readGatewayAccessRevision(): number {
  // Both owners advance monotonically; alias grants can change a page without changing its caller.
  return revision + readUserProfileAliasRevision();
}

/** Session keys a committed identity mutation can affect; none known means an unscoped change. */
export function sessionIdentityMutationKeys(mutation: SessionIdentityMutation): string[] {
  const targets =
    mutation.kind === "delete" ? [mutation.previous] : [mutation.previous, mutation.current];
  return targets.flatMap((target) => target.sessionKeys);
}

/**
 * Observes access changes that can affect one session (its raw and canonical keys): changes
 * naming it and every unscoped change. Unqualified keys match anything, so unclear scopes stay
 * conservative.
 */
export function onGatewaySessionAccessChanged(
  sessionKeys: readonly string[],
  listener: () => void,
): () => void {
  const targets = sessionKeys.map((key) => parseAgentSessionKey(key));
  const matches = (key: string) => {
    const parsed = parseAgentSessionKey(key);
    return targets.some(
      (target) =>
        !target || !parsed || (parsed.agentId === target.agentId && parsed.rest === target.rest),
    );
  };
  return registerListener(accessChangeListeners, (changed) => {
    if (!changed || changed.some(matches)) {
      listener();
    }
  });
}
