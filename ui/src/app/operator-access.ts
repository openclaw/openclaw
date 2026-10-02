import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

type GatewayOperatorAccess = Readonly<{
  canWrite: boolean;
  canAdmin: boolean;
  canPair: boolean;
  canReviewApprovals: boolean;
  canGrantApprovals: boolean;
}>;

type OperatorAuth = {
  role?: string;
  scopes?: readonly string[];
  sessionCap?: NonNullable<ApplicationGatewaySnapshot["hello"]>["auth"]["sessionCap"];
} | null;
type OperatorScope =
  | "operator.read"
  | "operator.sessions.read"
  | "operator.write"
  | "operator.admin"
  | "operator.pairing"
  | "operator.approvals";

function hasOperatorScope(
  auth: OperatorAuth,
  requestedScope: OperatorScope,
  missingAuthHasAccess: boolean,
): boolean {
  if (!auth) {
    return missingAuthHasAccess;
  }
  if (!auth.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: [requestedScope],
    allowedScopes: auth.scopes,
  });
}

export function readGatewayOperatorAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello"> | null | undefined,
): GatewayOperatorAccess {
  const auth = snapshot?.hello?.auth ?? null;
  return {
    canWrite: hasOperatorWriteAccess(auth),
    canAdmin: hasOperatorAdminAccess(auth),
    canPair: hasOperatorPairingAccess(auth),
    // Older Gateways did not advertise auth, but must retain approval review.
    canReviewApprovals: !auth || hasOperatorApprovalsAccess(auth),
    // Grants require an authenticated approval owner even on legacy snapshots.
    canGrantApprovals: hasOperatorApprovalsAccess(auth),
  };
}

export function hasOperatorWriteAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.write", true);
}

export function hasOperatorReadAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.read", true);
}

export function hasOperatorAdminAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.admin", true);
}

export function hasOperatorPairingAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.pairing", false);
}

export function hasOperatorApprovalsAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.approvals", false);
}

export function hasOperatorSelfReadAccess(auth: OperatorAuth): boolean {
  return hasOperatorReadAccess(auth) || hasOperatorScope(auth, "operator.sessions.read", true);
}

export function canReactToSession(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello" | "phase" | "client">,
  session: Pick<GatewaySessionRow, "sharingRole" | "visibility"> | undefined,
  options: { archived: boolean; catalog: boolean },
): boolean {
  const auth = snapshot.hello?.auth;
  const cap = auth?.sessionCap;
  const role = session?.sharingRole;
  if (
    !session ||
    !role ||
    options.archived ||
    options.catalog ||
    cap === "none" ||
    !canCallGatewayMethod(snapshot, "session.reactions.set", "operator.write")
  ) {
    return false;
  }
  const visibility = session.visibility ?? "shared";
  if (visibility === "draft") {
    return role === "owner" || role === "admin";
  }
  if (role !== "viewer") {
    return true;
  }
  return visibility === "shared"
    ? cap !== "view" && cap !== "suggest"
    : visibility === "suggest" && cap !== "view";
}
