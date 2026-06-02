export const ADMIN_SCOPE = "operator.admin" as const; // Full control-plane access; satisfies every operator scope.
/** Read-only control-plane access for status, catalogs, logs, and session reads. */
export const READ_SCOPE = "operator.read" as const;
/** Mutating operator access; also satisfies read-scoped gateway methods. */
export const WRITE_SCOPE = "operator.write" as const;
/** Approval APIs for exec and plugin approval decisions. */
export const APPROVALS_SCOPE = "operator.approvals" as const;
/** Pairing lifecycle APIs for devices, nodes, and issued operator tokens. */
export const PAIRING_SCOPE = "operator.pairing" as const;
/** Narrow access to Talk configuration payloads that include secrets. */
export const TALK_SECRETS_SCOPE = "operator.talk.secrets" as const;

/** Operator privileges advertised by gateway auth and checked by method policy. */
export type OperatorScope =
  | typeof ADMIN_SCOPE
  | typeof READ_SCOPE
  | typeof WRITE_SCOPE
  | typeof APPROVALS_SCOPE
  | typeof PAIRING_SCOPE
  | typeof TALK_SECRETS_SCOPE;

const KNOWN_OPERATOR_SCOPE_VALUES: readonly OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];

// Keep the runtime allowlist tied to OperatorScope so untrusted scope strings cannot
// drift from the public type exported to plugins and gateway clients.
const KNOWN_OPERATOR_SCOPES: ReadonlySet<OperatorScope> = new Set(KNOWN_OPERATOR_SCOPE_VALUES);

/** Narrows untrusted auth-token scope entries to the gateway's closed scope set. */
export function isOperatorScope(value: unknown): value is OperatorScope {
  return typeof value === "string" && KNOWN_OPERATOR_SCOPES.has(value as OperatorScope);
}
