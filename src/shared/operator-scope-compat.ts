const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_TALK_SCOPE = "operator.talk";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_CRON_SCOPE = "operator.cron";
const OPERATOR_READ_NO_ENROLLMENT_SCOPE = "operator.read.no-credential-enrollment";
const OPERATOR_WRITE_NO_ENROLLMENT_SCOPE = "operator.write.no-credential-enrollment";
const OPERATOR_SESSION_READ_SCOPE = "operator.sessions.read";
const OPERATOR_SESSION_WRITE_SCOPE = "operator.sessions.write";
const OPERATOR_SCOPE_PREFIX = "operator.";

/** Grant containment includes enrollment authority; ordinary checks must never mint grants. */
function operatorGrantScopeSatisfied(requestedScope: string, granted: readonly string[]): boolean {
  if (!requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) {
    return false;
  }
  if (granted.includes(requestedScope) || granted.includes(OPERATOR_ADMIN_SCOPE)) {
    return true;
  }
  const write = granted.includes(OPERATOR_WRITE_SCOPE);
  const ordinaryWrite = write || granted.includes(OPERATOR_WRITE_NO_ENROLLMENT_SCOPE);
  switch (requestedScope) {
    case OPERATOR_READ_SCOPE:
      return write;
    case OPERATOR_WRITE_NO_ENROLLMENT_SCOPE:
      return write;
    case OPERATOR_READ_NO_ENROLLMENT_SCOPE:
      return ordinaryWrite || granted.includes(OPERATOR_READ_SCOPE);
    case OPERATOR_CRON_SCOPE:
    case OPERATOR_TALK_SCOPE:
    case OPERATOR_SESSION_WRITE_SCOPE:
      return ordinaryWrite;
    case OPERATOR_SESSION_READ_SCOPE:
      return (
        ordinaryWrite ||
        granted.includes(OPERATOR_READ_SCOPE) ||
        granted.includes(OPERATOR_READ_NO_ENROLLMENT_SCOPE) ||
        granted.includes(OPERATOR_SESSION_WRITE_SCOPE)
      );
    default:
      return false;
  }
}

/** Ordinary operation admission, not comparison or issuance of persisted grants. */
export function operatorScopeSatisfied(
  requestedScope: string,
  granted: readonly string[],
): boolean {
  return (
    operatorGrantScopeSatisfied(requestedScope, granted) ||
    (requestedScope === OPERATOR_READ_SCOPE &&
      operatorGrantScopeSatisfied(OPERATOR_READ_NO_ENROLLMENT_SCOPE, granted)) ||
    (requestedScope === OPERATOR_WRITE_SCOPE &&
      operatorGrantScopeSatisfied(OPERATOR_WRITE_NO_ENROLLMENT_SCOPE, granted))
  );
}

/** Strict containment. Grants are canonical; requests retain blank skipping and original errors. */
export function resolveMissingOperatorScope(
  requestedScopes: readonly string[],
  allowedScopes: readonly string[],
): string | null {
  for (const scope of requestedScopes) {
    const requested = scope.trim();
    if (requested && !operatorGrantScopeSatisfied(requested, allowedScopes)) {
      return scope;
    }
  }
  return null;
}

/** Ordinary operation admission; use resolveMissingRequestedScope for grant containment. */
export function roleScopesAllow(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): boolean {
  if (params.role.trim() !== OPERATOR_ROLE) {
    return resolveMissingRequestedScope(params) === null;
  }
  const grants = params.allowedScopes.map((scope) => scope.trim());
  return params.requestedScopes.every(
    (scope) => !scope.trim() || operatorScopeSatisfied(scope.trim(), grants),
  );
}

/** Keeps only grants shared by both ceilings, never restoring enrollment authority. */
export function intersectOperatorScopes(
  scopes: readonly string[],
  ceiling: readonly string[],
): string[] {
  const contains = (requestedScopes: readonly string[], allowedScopes: readonly string[]) =>
    resolveMissingRequestedScope({ role: OPERATOR_ROLE, requestedScopes, allowedScopes }) === null;
  if (contains(scopes, ceiling)) {
    return [...scopes];
  }
  const result = [...new Set([...scopes, ...ceiling])].filter(
    (scope) => contains([scope], scopes) && contains([scope], ceiling),
  );
  // Incomparable ceilings may share an unspelled read/session subset.
  for (const scope of [
    OPERATOR_READ_NO_ENROLLMENT_SCOPE,
    OPERATOR_SESSION_WRITE_SCOPE,
    OPERATOR_SESSION_READ_SCOPE,
  ]) {
    if (contains([scope], scopes) && contains([scope], ceiling) && !contains([scope], result)) {
      result.push(scope);
    }
  }
  return result;
}

/** Strict role-grant containment; returns the original first missing requested scope. */
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
