import { createHmac, randomBytes } from "node:crypto";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";

// A process-local presentation handle, not a credential or a grant. After reconnect the
// picker reloads its inventory; an old handle must never resolve to a different account.
const key = randomBytes(32);

/** Number shared profiles within the provider, independently of failover order or readiness. */
export function sharedModelAccountOrdinals(store: AuthProfileStore, provider: string) {
  const ids = Object.entries(store.profiles)
    .flatMap(([id, credential]) =>
      credential.provider === provider && !isUserModelAuthProfileId(id) ? [id] : [],
    )
    .toSorted();
  return ids.length > 1 ? new Map(ids.map((id, index) => [id, index + 1])) : undefined;
}

export function sharedModelAccountRef(profileId: string): string {
  return `shared-ref:${createHmac("sha256", key).update(profileId).digest("base64url")}`;
}

export function isSharedModelAccountRef(id: string): boolean {
  return /^shared-ref:[A-Za-z0-9_-]{43}$/u.test(id);
}

export function resolveSharedModelAccountRef(
  ref: string,
  profileIds: Iterable<string>,
): string | undefined {
  for (const id of profileIds) {
    if (!isUserModelAuthProfileId(id) && sharedModelAccountRef(id) === ref) {
      return id;
    }
  }
  return undefined;
}
