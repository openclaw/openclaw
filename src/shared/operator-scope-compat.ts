const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_SCOPE_PREFIX = "operator.";

function normalizeScopeList(scopes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return [...out];
}

function operatorScopeSatisfied(requestedScope: string, granted: Set<string>): boolean {
  if (granted.has(OPERATOR_ADMIN_SCOPE) && requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) {
    return true;
  }
  if (requestedScope === OPERATOR_READ_SCOPE) {
    return granted.has(OPERATOR_READ_SCOPE) || granted.has(OPERATOR_WRITE_SCOPE);
  }
  if (requestedScope === OPERATOR_WRITE_SCOPE) {
    return granted.has(OPERATOR_WRITE_SCOPE);
  }
  return granted.has(requestedScope);
}

export function roleScopesAllow(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): boolean {
  const requested = normalizeScopeList(params.requestedScopes);
  if (requested.length === 0) {
    return true;
  }
  const allowed = normalizeScopeList(params.allowedScopes);
  if (allowed.length === 0) {
    return false;
  }
  const allowedSet = new Set(allowed);
  if (params.role.trim() !== OPERATOR_ROLE) {
    return requested.every((scope) => allowedSet.has(scope));
  }
  return requested.every((scope) => operatorScopeSatisfied(scope, allowedSet));
}
