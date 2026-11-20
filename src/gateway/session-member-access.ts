import type {
  SessionMemberPermissionLevel,
  SessionSharingRole,
  SessionVisibility,
} from "../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";

export type SessionMemberAccess = "owner" | "admin" | SessionMemberPermissionLevel | "none";
export type SessionMemberAccessFacts = {
  policy?: Pick<GatewayOperatorRoleDefinition, "sessions" | "scopes">;
  scopes: readonly string[];
  creator: boolean;
  admin: boolean;
  member: { present: boolean; access?: SessionMemberPermissionLevel };
  visibility: SessionVisibility;
  incognito?: boolean;
};

/** Sharing facts only: method scopes, agent admission, and lifecycle remain separate checks. */
export function resolveSessionMemberAccess(facts: SessionMemberAccessFacts): {
  access: SessionMemberAccess;
  role: SessionSharingRole;
  canRead: boolean;
  canMutate: boolean;
  canSuggest: boolean;
  level: SessionMemberPermissionLevel;
} {
  const cap = facts.policy?.sessions.others;
  const ceiling = cap === "invited" ? facts.policy?.sessions.maxInvitedAccess : undefined;
  const role: SessionSharingRole = facts.admin
    ? "admin"
    : facts.creator
      ? "owner"
      : cap === "write" && facts.visibility !== "draft" && !facts.incognito
        ? "member"
        : cap !== "none" && facts.member.present
          ? "member"
          : "viewer";
  const privileged = role === "owner" || role === "admin";
  const canRead =
    facts.admin ||
    (!facts.incognito &&
      (facts.creator ||
        (cap !== "none" &&
          (cap !== "invited" || facts.member.present) &&
          facts.visibility !== "draft")));
  const hidden = !privileged && (cap === "none" || (cap === "invited" && !facts.member.present));
  const capped = cap === "invited" || cap === "view" || cap === "suggest";
  const levels = ["read", "suggest", "send"] as const;
  const invitedLevel =
    ceiling && facts.member.present
      ? levels[Math.min(levels.indexOf(facts.member.access ?? "read"), levels.indexOf(ceiling))]!
      : undefined;
  const canMutate =
    ceiling && !privileged
      ? canRead && invitedLevel === "send"
      : !hidden &&
        (facts.visibility === "draft"
          ? privileged
          : role !== "viewer" || (facts.visibility === "shared" && !capped));
  const canSuggest =
    ceiling && !privileged
      ? canRead && (invitedLevel === "suggest" || invitedLevel === "send")
      : !(role === "viewer" && cap === "view") && facts.visibility === "suggest";
  // Mirrors the existing permission projection; session-only writes cannot start foreign turns.
  const canStart =
    operatorScopeSatisfied("operator.write", facts.scopes) ||
    (facts.creator && operatorScopeSatisfied("operator.sessions.write", facts.scopes));
  const level =
    canStart && canMutate
      ? "send"
      : operatorScopeSatisfied("operator.write", facts.scopes) && canSuggest
        ? "suggest"
        : "read";
  return {
    access: !canRead ? "none" : privileged ? role : ceiling ? (invitedLevel ?? "none") : level,
    role,
    canRead,
    canMutate,
    canSuggest,
    level,
  };
}
