import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const operatorAuthorityIdentities = resolveGlobalSingleton(
  Symbol.for("openclaw.replyOperatorAuthorityIdentities"),
  () => ({ keys: new WeakMap<object, number>(), nextId: 1 }),
);

/** Compare original live owners without treating profile labels as authority. */
export function resolveReplyOperatorAuthorityKey(
  authority: AdmittedRunOperatorAuthority | undefined,
): string {
  if (!authority) {
    return "";
  }
  const identities = [authority.source ?? authority, authority.invocation].map((owner) => {
    if (!owner) {
      return null;
    }
    let identity = operatorAuthorityIdentities.keys.get(owner);
    if (identity === undefined) {
      identity = operatorAuthorityIdentities.nextId++;
      operatorAuthorityIdentities.keys.set(owner, identity);
    }
    return identity;
  });
  return JSON.stringify([
    authority.profileId,
    [...new Set(authority.scopes.map((scope) => scope.trim()).filter(Boolean))].toSorted(),
    ...identities,
  ]);
}
