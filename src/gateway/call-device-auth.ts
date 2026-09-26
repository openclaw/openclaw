import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  loadDeviceAuthToken,
  loadDeviceAuthTokenReadOnly,
  loadOriginDeviceToken,
  loadOriginDeviceTokenReadOnly,
} from "../infra/device-auth-store.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import type { resolveGatewayAuth } from "./auth-resolve.js";
import type { GatewayClientOptions } from "./client.js";
import { isLoopbackGatewayUrl } from "./net.js";

export type GatewayCallDeviceAuthOptions = Pick<
  GatewayClientOptions,
  | "mode"
  | "clientName"
  | "deviceIdentity"
  | "preparedDeviceAuth"
  | "sharedStateMode"
  | "approvalRuntimeToken"
  | "agentRuntimeIdentityToken"
> & {
  useStoredDeviceAuth?: boolean;
  requireLocalBackendSharedAuth?: boolean;
  /** Reuse local auth-none authority without opening device storage for ordinary CLI RPCs. */
  allowLocalBackendAuthNone?: boolean;
};

export class GatewayLocalBackendSharedAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayLocalBackendSharedAuthUnavailableError";
  }
}

// Readiness and maintenance are the same local-control trust boundary. Shared
// secrets/auth-none keep their local contracts; other modes reuse only a paired
// identity from the service's state directory, without pairing or state writes.
export async function resolveReadOnlyLocalGatewayAuth(params: {
  auth?: { token?: string; password?: string };
  authNone: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const { auth, authNone, env } = params;
  const identity =
    authNone || auth?.token || auth?.password ? null : loadDeviceIdentityIfPresent({ env });
  const preparedDeviceAuth = await loadStoredOperatorDeviceAuthToken(
    identity,
    undefined,
    "read-only",
    env,
  );
  return {
    token: auth?.token,
    password: auth?.password,
    skipImplicitAuth: true,
    clientName: authNone ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
    mode: authNone ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
    requireLocalBackendSharedAuth: authNone,
    deviceIdentity: preparedDeviceAuth ? identity : null,
    preparedDeviceAuth: preparedDeviceAuth ?? undefined,
    sharedStateMode: "read-only" as const,
  };
}

export function resolveDeviceIdentityForGatewayCall(
  sharedStateMode?: "read-only",
): DeviceIdentity | null {
  try {
    return sharedStateMode === "read-only"
      ? loadDeviceIdentityIfPresent()
      : loadOrCreateDeviceIdentity();
  } catch {
    // Read-only or restricted environments should still be able to call the
    // gateway with token/password auth without crashing before the RPC.
    return null;
  }
}

export function resolveGatewayCallDeviceAuth(params: {
  opts: GatewayCallDeviceAuthOptions;
  url: string;
  authMode: ReturnType<typeof resolveGatewayAuth>["mode"];
  isImplicitLocalTarget: boolean;
  token?: string;
  password?: string;
}) {
  const { opts } = params;
  const isLoopback = isLoopbackGatewayUrl(params.url);
  const clientOptions = {
    clientName: opts.clientName,
    mode: opts.mode,
    requireLocalBackendSharedAuth: opts.requireLocalBackendSharedAuth,
  };
  if (
    opts.allowLocalBackendAuthNone &&
    params.authMode === "none" &&
    params.isImplicitLocalTarget &&
    isLoopback &&
    opts.clientName === GATEWAY_CLIENT_NAMES.CLI &&
    opts.mode === GATEWAY_CLIENT_MODES.CLI &&
    opts.deviceIdentity === undefined &&
    !opts.useStoredDeviceAuth &&
    !opts.preparedDeviceAuth &&
    !opts.approvalRuntimeToken &&
    !opts.agentRuntimeIdentityToken
  ) {
    clientOptions.clientName = GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
    clientOptions.mode = GATEWAY_CLIENT_MODES.BACKEND;
    clientOptions.requireLocalBackendSharedAuth = true;
  }
  const mode = clientOptions.mode ?? GATEWAY_CLIENT_MODES.CLI;
  const clientName = clientOptions.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
  const allowAuthNone =
    clientOptions.requireLocalBackendSharedAuth === true && params.authMode === "none";
  // Inactive ambient credentials must not turn an auth-none CLI call device-less.
  // Omit identity only when the Gateway will actually authenticate the supplied secret.
  const hasSharedSecretAuth =
    (params.authMode === "token" && Boolean(params.token)) ||
    (params.authMode === "password" && Boolean(params.password));
  const isLocalBackendSharedAuth =
    mode === GATEWAY_CLIENT_MODES.BACKEND &&
    clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT &&
    (hasSharedSecretAuth || allowAuthNone) &&
    isLoopback;
  const isLocalCliSharedAuth =
    mode === GATEWAY_CLIENT_MODES.CLI &&
    clientName === GATEWAY_CLIENT_NAMES.CLI &&
    hasSharedSecretAuth &&
    isLoopback;
  const omitDeviceIdentity = isLocalBackendSharedAuth || isLocalCliSharedAuth;
  if (clientOptions.requireLocalBackendSharedAuth && !omitDeviceIdentity) {
    throw new GatewayLocalBackendSharedAuthUnavailableError(
      "local backend shared auth requires a loopback gateway with token/password credentials or auth mode none",
    );
  }
  const deviceIdentity =
    opts.deviceIdentity === undefined
      ? omitDeviceIdentity
        ? null
        : resolveDeviceIdentityForGatewayCall(opts.sharedStateMode)
      : opts.deviceIdentity;
  return { clientOptions, omitDeviceIdentity, deviceIdentity };
}

export async function loadStoredOperatorDeviceAuthToken(
  deviceIdentity: DeviceIdentity | null,
  deviceAuthScope?: string,
  sharedStateMode?: "read-only",
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeviceAuthEntry | null> {
  if (!deviceIdentity) {
    return null;
  }
  try {
    if (deviceAuthScope) {
      const loadToken =
        sharedStateMode === "read-only" ? loadOriginDeviceTokenReadOnly : loadOriginDeviceToken;
      return await loadToken({
        gatewayScope: deviceAuthScope,
        deviceId: deviceIdentity.deviceId,
        role: "operator",
        env,
      });
    }
    const loadToken =
      sharedStateMode === "read-only" ? loadDeviceAuthTokenReadOnly : loadDeviceAuthToken;
    return await loadToken({
      deviceId: deviceIdentity.deviceId,
      role: "operator",
      env,
    });
  } catch {
    return null;
  }
}
