import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";

let revision = 0;
const readScopes = new Set<(change?: SessionIdentityMutation) => void>();

/** Marks Gateway access decisions stale across asynchronously yielded reads. */
export function bumpGatewayAccessRevision(change?: SessionIdentityMutation): void {
  revision += 1;
  for (const invalidate of readScopes) {
    invalidate(change);
  }
}

/** Observe synchronous lookup dependencies; this scope retains no authorization decision. */
export function createGatewayAccessReadScope() {
  const aliasRevision = readUserProfileAliasRevision();
  const sessionKeys = new Set<string>();
  let allIdentities = false;
  let current = true;
  const invalidate = (change?: SessionIdentityMutation) => {
    const changedKeys = change
      ? [
          ...change.previous.sessionKeys,
          ...(change.kind === "delete" ? [] : change.current.sessionKeys),
        ]
      : [];
    if (
      !change ||
      allIdentities ||
      changedKeys.length === 0 ||
      changedKeys.some((key) => sessionKeys.has(key))
    ) {
      current = false;
    }
  };
  readScopes.add(invalidate);
  return {
    dependOnSessionKeys(keys: readonly string[]) {
      for (const key of keys) {
        sessionKeys.add(key);
      }
    },
    dependOnAllSessionIdentities() {
      allIdentities = true;
    },
    isCurrent: () => current && aliasRevision === readUserProfileAliasRevision(),
    dispose() {
      current = false;
      readScopes.delete(invalidate);
      sessionKeys.clear();
    },
  };
}

export type GatewayAccessReadScope = ReturnType<typeof createGatewayAccessReadScope>;

export function readGatewayAccessRevision(): number {
  // Both owners advance monotonically; alias grants can change a page without changing its caller.
  return revision + readUserProfileAliasRevision();
}
