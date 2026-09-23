import type { OperatorScope } from "../../../src/gateway/operator-scopes.js";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import {
  resolveBaseSessionMutationRequiredScope,
  resolveSessionMethodScope,
} from "../../../src/shared/session-method-scopes-base.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

type SessionAccessRow = Pick<GatewaySessionRow, "sharingRole">;

export type SessionMethodAccess =
  | { allowed: true; requiredScope: OperatorScope }
  | {
      allowed: false;
      requiredScope: OperatorScope;
      reason: string;
      cause: "disconnected" | "method-unavailable" | "missing-scope" | "session-not-owned";
    };

export type SessionMethodAccessRequest = {
  method: string;
  params?: unknown;
  requiredScope?: OperatorScope;
  /** Only callers exposing a scoped action opt into the Gateway's narrow alternative. */
  sessionScope?: boolean;
  session?: SessionAccessRow;
};

export function sessionAccessRowForBatch(rows: readonly SessionAccessRow[]) {
  return rows.find((row) => row.sharingRole !== "owner" && row.sharingRole !== "admin") ?? rows[0];
}

function deniedAccess(
  requiredScope: OperatorScope,
  cause: Exclude<SessionMethodAccess, { allowed: true }>["cause"],
): SessionMethodAccess {
  return {
    allowed: false,
    requiredScope,
    cause,
    reason: t(
      cause === "disconnected"
        ? "sessionsView.actionRequiresConnection"
        : cause === "method-unavailable"
          ? "sessionsView.actionUnavailable"
          : cause === "session-not-owned"
            ? "sessionsView.actionRequiresOwnership"
            : "sessionsView.actionRequiresScope",
      { scope: requiredScope },
    ),
  };
}

/** Local draft presentation uses the same grant and ownership decision while offline. */
export function readSessionMethodScopeAccess(
  auth: { role?: string; scopes?: readonly string[] } | null | undefined,
  request: SessionMethodAccessRequest,
): SessionMethodAccess {
  const broadScope =
    request.requiredScope === "operator.admin"
      ? request.requiredScope
      : (resolveBaseSessionMutationRequiredScope(request.method, request.params) ??
        request.requiredScope);
  const requiredScope =
    (request.sessionScope && broadScope !== "operator.admin"
      ? resolveSessionMethodScope(request.method, request.params)
      : undefined) ?? broadScope;
  if (!requiredScope) {
    throw new Error(`Missing session method scope: ${request.method}`);
  }
  const scopes = auth?.scopes;
  const role = auth?.role ?? "operator";
  if (
    !Array.isArray(scopes) ||
    !roleScopesAllow({ role, requestedScopes: [requiredScope], allowedScopes: scopes })
  ) {
    return deniedAccess(requiredScope, "missing-scope");
  }
  if (
    requiredScope === "operator.sessions.write" &&
    !roleScopesAllow({ role, requestedScopes: ["operator.write"], allowedScopes: scopes }) &&
    request.session?.sharingRole !== "owner" &&
    request.session?.sharingRole !== "admin"
  ) {
    return deniedAccess(requiredScope, "session-not-owned");
  }
  return { allowed: true, requiredScope };
}

/** Combines scoped action access with the live connection and advertised method catalog. */
export function readSessionMethodAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  request: SessionMethodAccessRequest,
): SessionMethodAccess {
  const access = readSessionMethodScopeAccess(snapshot?.hello?.auth, request);
  if (snapshot?.phase !== "connected" || !snapshot.client) {
    return deniedAccess(access.requiredScope, "disconnected");
  }
  if (isGatewayMethodAdvertised(snapshot, request.method) !== true) {
    return deniedAccess(access.requiredScope, "method-unavailable");
  }
  return access;
}
