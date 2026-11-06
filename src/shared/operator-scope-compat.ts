const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_TALK_SCOPE = "operator.talk";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_CRON_SCOPE = "operator.cron";
const OPERATOR_SESSION_READ_SCOPE = "operator.sessions.read";
const OPERATOR_SESSION_WRITE_SCOPE = "operator.sessions.write";
const OPERATOR_SCOPE_PREFIX = "operator.";

export function operatorScopeSatisfied(
  requestedScope: string,
  granted: readonly string[],
): boolean {
  if (!requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) {
    return false;
  }
  return (
    granted.includes(requestedScope) ||
    granted.includes(OPERATOR_ADMIN_SCOPE) ||
    ((requestedScope === OPERATOR_READ_SCOPE ||
      requestedScope === OPERATOR_TALK_SCOPE ||
      requestedScope === OPERATOR_CRON_SCOPE ||
      requestedScope === OPERATOR_SESSION_READ_SCOPE ||
      requestedScope === OPERATOR_SESSION_WRITE_SCOPE) &&
      granted.includes(OPERATOR_WRITE_SCOPE)) ||
    (requestedScope === OPERATOR_SESSION_READ_SCOPE &&
      (granted.includes(OPERATOR_READ_SCOPE) || granted.includes(OPERATOR_SESSION_WRITE_SCOPE)))
  );
}

/** Grants must be canonical; requests retain blank skipping and original error strings. */
export function resolveMissingOperatorScope(
  requestedScopes: readonly string[],
  allowedScopes: readonly string[],
): string | null {
  for (const scope of requestedScopes) {
    const requested = scope.trim();
    if (requested && !operatorScopeSatisfied(requested, allowedScopes)) {
      return scope;
    }
  }
  return null;
}

/** Returns true when a role grant satisfies requested scopes, including operator implications. */
export function roleScopesAllow(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): boolean {
  return resolveMissingRequestedScope(params) === null;
}

/** Keeps only permissions shared by both ceilings, including implied operator scopes. */
export function intersectOperatorScopes(
  scopes: readonly string[],
  ceiling: readonly string[],
): string[] {
  if (roleScopesAllow({ role: "operator", requestedScopes: scopes, allowedScopes: ceiling })) {
    return [...scopes];
  }
  const result = [...new Set([...scopes, ...ceiling])].filter(
    (scope) =>
      roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes: scopes }) &&
      roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes: ceiling }),
  );
  // General reads and session-only writes share a narrower read capability even
  // when neither input spells it out. Do not add redundant or one-sided grants.
  for (const scope of [OPERATOR_SESSION_WRITE_SCOPE, OPERATOR_SESSION_READ_SCOPE]) {
    if (
      operatorScopeSatisfied(scope, scopes) &&
      operatorScopeSatisfied(scope, ceiling) &&
      !operatorScopeSatisfied(scope, result)
    ) {
      result.push(scope);
    }
  }
  return result;
}

/** Returns the original first requested scope not covered by the role's allowed scopes. */
export function resolveMissingRequestedScope(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): string | null {
  const role = params.role.trim();
  const allowedScopes = params.allowedScopes.map((scope) => scope.trim());
  if (role === OPERATOR_ROLE) {
    return resolveMissingOperatorScope(params.requestedScopes, allowedScopes);
  }
  const prefix = `${role}.`;
  for (const scope of params.requestedScopes) {
    const requestedScope = scope.trim();
    if (!requestedScope) {
      continue;
    }
    if (!requestedScope.startsWith(prefix) || !allowedScopes.includes(requestedScope)) {
      return scope;
    }
  }
  return null;
}

/** Returns the first requested scope that does not belong to any requested role. */
export function resolveScopeOutsideRequestedRoles(params: {
  requestedRoles: readonly string[];
  requestedScopes: readonly string[];
}): string | null {
  const prefixes = params.requestedRoles.map((role) => `${role.trim()}.`);
  for (const scope of params.requestedScopes) {
    const requestedScope = scope.trim();
    if (!prefixes.some((prefix) => !requestedScope || requestedScope.startsWith(prefix))) {
      return scope;
    }
  }
  return null;
}
