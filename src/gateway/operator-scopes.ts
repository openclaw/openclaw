// Gateway operator scope constants.
// Defines the closed set accepted by connection auth and method policy.
export const ADMIN_SCOPE = "operator.admin" as const;
export const READ_SCOPE = "operator.read" as const;
export const WRITE_SCOPE = "operator.write" as const;
export const SESSION_READ_SCOPE = "operator.sessions.read" as const;
export const SESSION_WRITE_SCOPE = "operator.sessions.write" as const;
export const APPROVALS_SCOPE = "operator.approvals" as const;
export const QUESTIONS_SCOPE = "operator.questions" as const;
export const PAIRING_SCOPE = "operator.pairing" as const;
export const TALK_SCOPE = "operator.talk" as const;
export const TALK_SECRETS_SCOPE = "operator.talk.secrets" as const;

const KNOWN_OPERATOR_SCOPE_VALUES = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  SESSION_READ_SCOPE,
  SESSION_WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  PAIRING_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
] as const;

/** Operator privileges advertised by gateway auth and checked by method policy. */
export type OperatorScope = (typeof KNOWN_OPERATOR_SCOPE_VALUES)[number];

const KNOWN_OPERATOR_SCOPES: ReadonlySet<string> = new Set(KNOWN_OPERATOR_SCOPE_VALUES);

/** Narrows untrusted auth-token scope entries to the gateway's closed scope set. */
export function isOperatorScope(value: unknown): value is OperatorScope {
  return typeof value === "string" && KNOWN_OPERATOR_SCOPES.has(value);
}

/** Filters unknown strings down to unique operator scopes; undefined stays undefined. */
export function normalizeOperatorScopeList(
  scopes: string[] | undefined,
): OperatorScope[] | undefined {
  if (!Array.isArray(scopes)) {
    return undefined;
  }
  const normalized: OperatorScope[] = [];
  for (const scope of scopes) {
    if (isOperatorScope(scope) && !normalized.includes(scope)) {
      normalized.push(scope);
    }
  }
  return normalized;
}
