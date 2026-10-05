import type { UsersSelfResult } from "../../../packages/gateway-protocol/src/index.ts";
import type { PresenceEntry } from "../api/types.ts";

export type AuthenticatedUser = NonNullable<PresenceEntry["user"]> & {
  authenticatedGitHubIdentity?: UsersSelfResult["authenticatedGitHubIdentity"];
};
export type PresencePayload = { presence: readonly PresenceEntry[] };

export function sameSelfUser(
  left: AuthenticatedUser | null | undefined,
  right: AuthenticatedUser | null | undefined,
): boolean {
  return (
    left?.id === right?.id &&
    left?.identity?.id === right?.identity?.id &&
    left?.email === right?.email &&
    left?.name === right?.name &&
    left?.avatarUrl === right?.avatarUrl &&
    left?.authenticatedGitHubIdentity?.host === right?.authenticatedGitHubIdentity?.host &&
    left?.authenticatedGitHubIdentity?.accountId ===
      right?.authenticatedGitHubIdentity?.accountId &&
    left?.authenticatedGitHubIdentity?.login === right?.authenticatedGitHubIdentity?.login &&
    left?.authenticatedGitHubIdentity?.profileUrl ===
      right?.authenticatedGitHubIdentity?.profileUrl &&
    left?.authenticatedGitHubIdentity?.gitCoauthorEligible ===
      right?.authenticatedGitHubIdentity?.gitCoauthorEligible
  );
}

export function readPresenceEntries(value: unknown): PresenceEntry[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const presence = (value as { presence?: unknown }).presence;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : undefined;
}

export function resolveSelfPresenceUser(
  entries: readonly PresenceEntry[],
  instanceId: string | undefined,
): AuthenticatedUser | null {
  if (!instanceId) {
    return null;
  }
  const entry = entries.find(
    (candidate) => candidate.instanceId === instanceId && candidate.reason !== "disconnect",
  );
  return entry?.user?.id ? entry.user : null;
}

/** Gateway identity, including explicit null, takes precedence over possibly stale presence. */
export function resolveCurrentSelfUser({
  snapshotUser,
  presenceEntries,
  presenceInstanceId,
}: {
  snapshotUser?: AuthenticatedUser | null;
  presenceEntries?: readonly PresenceEntry[];
  presenceInstanceId?: string;
}): AuthenticatedUser | null {
  return snapshotUser !== undefined
    ? snapshotUser
    : resolveSelfPresenceUser(presenceEntries ?? [], presenceInstanceId);
}
