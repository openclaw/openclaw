import { SESSION_APPROVAL_RECIPIENTS } from "../../../packages/gateway-protocol/src/server-capabilities.ts";
import type { GatewayHelloOk } from "../api/gateway.ts";
import { hasOperatorApprovalsAccess } from "./operator-access.ts";
import { resolveSelfPresenceUser, type AuthenticatedUser } from "./user-profile.ts";

/** Opt-in only: the Gateway selects exact creator, reviewer, and own-turn status recipients. */
export function canSubscribeSessionApprovals(
  hello: GatewayHelloOk | null | undefined,
  instanceId?: string,
  selfUser?: AuthenticatedUser | null,
): boolean {
  if (!hello) {
    return false;
  }
  // The Gateway admits non-reviewers only with an authenticated profile, not a bare principal id.
  const profileUser = (user: AuthenticatedUser | null | undefined) =>
    user?.identity?.type === "profile";
  return (
    hasOperatorApprovalsAccess(hello.auth ?? null) ||
    Boolean(
      hello.features?.capabilities?.includes(SESSION_APPROVAL_RECIPIENTS) &&
      hello.auth?.role === "operator" &&
      (profileUser(selfUser) ||
        hello.auth.profileActivityViewerId ||
        profileUser(resolveSelfPresenceUser(hello.snapshot?.presence ?? [], instanceId))),
    )
  );
}
