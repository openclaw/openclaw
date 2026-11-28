// Scope selection for CLI Gateway calls whose scopes were derived from the method.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readPairingConnectErrorDetails } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { readMissingScopeErrorDetails } from "../../packages/gateway-protocol/src/gateway-error-details.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { CallGatewayBaseOptions } from "./call-options.js";
import {
  ADMIN_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
  type OperatorScope,
} from "./operator-scopes.js";

function shouldEscalateSessionCreateCwdScope(params: {
  opts: CallGatewayBaseOptions;
  scopes: readonly OperatorScope[];
  error: unknown;
}): boolean {
  if (
    params.opts.method !== "sessions.create" ||
    !isRecord(params.opts.params) ||
    !normalizeOptionalString(params.opts.params.cwd) ||
    params.scopes.length !== 1 ||
    params.scopes[0] !== WRITE_SCOPE
  ) {
    return false;
  }
  const errorRecord = isRecord(params.error) ? params.error : undefined;
  const missingScope = readMissingScopeErrorDetails(errorRecord?.details);
  return (
    missingScope?.missingScope === ADMIN_SCOPE && missingScope.requiredScopes.includes(ADMIN_SCOPE)
  );
}

async function fitScopesToGrant(
  opts: CallGatewayBaseOptions,
  scopes: OperatorScope[],
  grantedScopes: readonly string[],
): Promise<OperatorScope[]> {
  const { fitOperatorScopesToGrant } = await import("./method-scopes.js");
  return fitOperatorScopesToGrant({
    method: opts.method,
    requestParams: opts.params,
    scopes,
    grantedScopes,
  });
}

/**
 * A device paired with only session scopes (a team guest) is served session
 * methods through their session-scoped alternative. Requesting the general
 * scope instead would make the Gateway file a scope-upgrade request.
 */
export async function fitScopesToStoredDeviceGrant(params: {
  opts: CallGatewayBaseOptions;
  scopes: OperatorScope[] | undefined;
  /** Explicit scopes, stored-auth calls and shared secrets keep their request. */
  keepRequest: boolean;
  loadGrant: () => Promise<DeviceAuthEntry | null>;
  /** gateway.remote.edgeAuth: the proxy authenticates, not the stored grant. */
  proxyAuthenticated?: boolean;
}): Promise<OperatorScope[] | undefined> {
  const { opts, scopes } = params;
  if (!scopes) {
    return scopes;
  }
  // A ceiling goes out whole only when the device connects by its stored grant
  // and that grant covers it; otherwise the method's least-privilege scopes go
  // out, as before the ceiling, so the call never files a scope upgrade and a
  // shared-secret or proxy session never asks the Gateway to re-mint the token.
  if (opts.grantCeiling === true) {
    const grantedScopes =
      params.keepRequest || params.proxyAuthenticated
        ? []
        : ((await params.loadGrant())?.scopes ?? []);
    if (
      roleScopesAllow({ role: "operator", requestedScopes: scopes, allowedScopes: grantedScopes })
    ) {
      return scopes;
    }
    const { resolveLeastPrivilegeOperatorScopesForMethod } = await import("./method-scopes.js");
    return resolveLeastPrivilegeOperatorScopesForMethod(opts.method, opts.params);
  }
  if (params.keepRequest) {
    return scopes;
  }
  const grantedScopes = (await params.loadGrant())?.scopes;
  return grantedScopes?.length ? await fitScopesToGrant(opts, scopes, grantedScopes) : scopes;
}

/** One retry after a structured, pre-mutation scope refusal. */
export async function resolveCliScopeRetry(params: {
  opts: CallGatewayBaseOptions;
  scopes: OperatorScope[];
  error: unknown;
}): Promise<{ opts: CallGatewayBaseOptions; scopes: OperatorScope[] } | undefined> {
  const { opts } = params;
  // sessions.create checks filesystem-backed cwd containment before mutation.
  // Retry only that structured escalation on an admin connection.
  if (shouldEscalateSessionCreateCwdScope(params)) {
    return { opts, scopes: [ADMIN_SCOPE] };
  }
  // A device approved before it ever connected has no stored grant, so its
  // first request can exceed it. The scope-upgrade refusal reports the approved
  // scopes; when they serve this method through its session scope, retry with
  // that grant. The retry keeps the caller's storage mode: a read-only call
  // stores no device token, so it is refused again until a writable client
  // stores the grant.
  const pairing = readPairingConnectErrorDetails(
    isRecord(params.error) ? params.error.details : undefined,
  );
  if (pairing?.reason !== "scope-upgrade" || !pairing.approvedScopes?.length) {
    return undefined;
  }
  const grantedScopes = pairing.approvedScopes.filter(isOperatorScope);
  const fitted = await fitScopesToGrant(opts, params.scopes, grantedScopes);
  return fitted === params.scopes ? undefined : { opts, scopes: grantedScopes };
}
