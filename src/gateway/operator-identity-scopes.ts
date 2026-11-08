import type { OperatorScope } from "./operator-scopes.js";

/** Shared lookup for verified login grants; role policy still caps the result. */
export function resolveIdentityOperatorScopes(
  verifiedIdentity: string,
  identityScopes: Record<string, OperatorScope[]> | undefined,
): OperatorScope[] {
  const exact = identityScopes?.[verifiedIdentity];
  if (exact !== undefined || !verifiedIdentity.includes("@")) {
    return exact ?? [];
  }
  const normalizedIdentity = verifiedIdentity.toLowerCase();
  return (
    Object.entries(identityScopes ?? {}).find(
      ([identity]) => identity.includes("@") && identity.toLowerCase() === normalizedIdentity,
    )?.[1] ?? []
  );
}
