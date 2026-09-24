import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { projectOperatorScopesForMethod } from "./method-scopes.js";
import {
  ADMIN_SCOPE,
  READ_SCOPE,
  SESSION_READ_SCOPE,
  SESSION_WRITE_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
} from "./operator-scopes.js";

export function resolveInProcessGatewaySyntheticScopes(params: {
  method: string;
  requestParams: unknown;
  syntheticScopes?: string[];
  syntheticScopeMode?: "minimum" | "exact";
  operatorScopes?: readonly string[];
  scopedClientScopes?: readonly string[];
  registeredScope?: string;
}): string[] | undefined {
  const { operatorScopes, syntheticScopeMode } = params;
  const requestedSyntheticScopes = (
    params.syntheticScopes ??
    (syntheticScopeMode === "exact"
      ? (operatorScopes ?? params.scopedClientScopes)
      : undefined) ?? [WRITE_SCOPE]
  ).map((requested) => {
    const broad =
      requested === SESSION_READ_SCOPE
        ? READ_SCOPE
        : requested === SESSION_WRITE_SCOPE
          ? WRITE_SCOPE
          : undefined;
    return syntheticScopeMode === "minimum" &&
      broad &&
      operatorScopes &&
      roleScopesAllow({ role: "operator", requestedScopes: [broad], allowedScopes: operatorScopes })
      ? broad
      : requested;
  });
  // Narrow by authority, not literal membership: write also authorizes reads
  // and Talk, including tools called by a synthetic continuation.
  const syntheticScopes = operatorScopes
    ? syntheticScopeMode === "exact"
      ? requestedSyntheticScopes.filter((requestedScope) =>
          roleScopesAllow({
            role: "operator",
            requestedScopes: [requestedScope],
            allowedScopes: operatorScopes,
          }),
        )
      : projectOperatorScopesForMethod({
          method: params.method,
          requestParams: params.requestParams,
          requestedScopes: requestedSyntheticScopes,
          allowedScopes: operatorScopes,
          ...(isOperatorScope(params.registeredScope)
            ? { requiredScope: params.registeredScope }
            : {}),
        })
    : syntheticScopeMode === "exact"
      ? requestedSyntheticScopes
      : params.syntheticScopes;
  if (
    syntheticScopeMode !== "exact" &&
    operatorScopes?.includes(ADMIN_SCOPE) &&
    !syntheticScopes?.includes(ADMIN_SCOPE)
  ) {
    syntheticScopes?.push(ADMIN_SCOPE);
  }
  return syntheticScopes;
}
