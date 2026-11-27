import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { readParticipantPublicationAuthority } from "./github-publication-participation.js";
import { isInProcessSessionRun } from "./in-process-session-run.js";
import { projectOperatorScopesForMethod, resolveAgentRuntimeCronScope } from "./method-scopes.js";
import {
  ADMIN_SCOPE,
  READ_SCOPE,
  SESSION_READ_SCOPE,
  SESSION_WRITE_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
} from "./operator-scopes.js";
import type { DispatchGatewayMethodInProcessOptions } from "./server-plugin-in-process-dispatch.types.js";

/** Project the recorded caller ceiling to this native dispatch without manufacturing grants. */
export function resolveInProcessSyntheticScopes({
  method,
  params,
  operatorScopes,
  operatorAuthority,
  options,
  registeredScope,
  allowOwnSessionScope,
  clientScopes,
  agentRuntime,
}: {
  method: string;
  params: unknown;
  operatorScopes?: readonly string[];
  operatorAuthority?: AdmittedRunOperatorAuthority;
  options?: DispatchGatewayMethodInProcessOptions;
  registeredScope?: string;
  allowOwnSessionScope?: boolean;
  clientScopes?: string[];
  agentRuntime: boolean;
}) {
  const syntheticScopeMode = options?.syntheticScopeMode;
  const cronScope = agentRuntime && resolveAgentRuntimeCronScope(method);
  // Scheduling retains the initiating grant for the saved continuation, not only
  // permission to edit its job. Other scoped cron calls need just cron authority.
  const cronScopes = cronScope
    ? ((method === "cron.add" || method === "cron.update" ? operatorScopes : undefined) ?? [
        cronScope,
      ])
    : undefined;
  const requestedSyntheticScopes = (
    (syntheticScopeMode === "minimum" ? cronScopes : undefined) ??
    options?.syntheticScopes ??
    (syntheticScopeMode === "exact" ? (operatorScopes ?? clientScopes) : undefined) ?? [WRITE_SCOPE]
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
  const participantPublication = readParticipantPublicationAuthority(method, params);
  const participantLaunch = Boolean(
    (isInProcessSessionRun(method, params) && operatorAuthority?.participationCeiling) ||
    participantPublication,
  );
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
          method,
          requestParams: params,
          requestedScopes: participantLaunch ? [READ_SCOPE] : requestedSyntheticScopes,
          allowedScopes: operatorScopes,
          ...(allowOwnSessionScope ||
          isInProcessSessionRun(method, params) ||
          participantPublication
            ? {
                sessionScope: participantLaunch ? SESSION_READ_SCOPE : SESSION_WRITE_SCOPE,
              }
            : {}),
          ...(participantLaunch
            ? { requiredScope: READ_SCOPE }
            : isOperatorScope(registeredScope)
              ? { requiredScope: registeredScope }
              : {}),
        })
    : syntheticScopeMode === "exact"
      ? requestedSyntheticScopes
      : options?.syntheticScopes;
  if (
    syntheticScopeMode !== "exact" &&
    operatorScopes?.includes(ADMIN_SCOPE) &&
    !syntheticScopes?.includes(ADMIN_SCOPE)
  ) {
    syntheticScopes?.push(ADMIN_SCOPE);
  }
  return syntheticScopes;
}
