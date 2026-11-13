import { loadInteractiveOperatorDeviceIdentity } from "../cli/interactive-device-auth.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { loadStoredOperatorDeviceAuthToken } from "../gateway/call-device-auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import {
  resolveGatewayClientBootstrap,
  resolveGatewayUrlOverride,
} from "../gateway/client-bootstrap.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import {
  resolveGatewayDeviceAuthRoute,
  type GatewaySshRoute,
} from "../gateway/connection-details.js";
import { resolveExplicitGatewayAuth } from "../gateway/credentials.js";
import {
  gatewayEdgeAuthValueForTarget,
  normalizeEdgeAuthHeadersConfig,
  resolveEdgeAuthHeaders,
} from "../gateway/edge-auth.js";
import { loadOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readActiveGatewayLockPort } from "../infra/gateway-lock.js";
import type { TuiBoundGateway, TuiGatewayConnectionOptions } from "./tui-types.js";

export type ResolvedGatewayConnection = {
  url: string;
  deviceAuth?: true;
  deviceIdentity?: GatewayClientOptions["deviceIdentity"];
  preparedDeviceAuth?: GatewayClientOptions["preparedDeviceAuth"];
  deviceAuthScope?: string;
  sshTunnel?: GatewaySshRoute;
  token?: string;
  password?: string;
  edgeAuthHeaders?: Readonly<Record<string, string>>;
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
};

function throwGatewayAuthResolutionError(reason: string): never {
  throw new Error(
    [
      reason,
      "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass --token/--password,",
      "or resolve the configured secret provider for this credential.",
    ].join("\n"),
  );
}

async function hasStoredOriginDeviceAuth(deviceAuthScope: string): Promise<boolean> {
  try {
    const identity = await loadDeviceIdentityIfPresentAsync();
    return Boolean(
      identity &&
      (
        await loadOriginDeviceToken({
          gatewayScope: deviceAuthScope,
          deviceId: identity.deviceId,
          role: "operator",
        })
      )?.token,
    );
  } catch {
    return false;
  }
}

function resolveTuiEdgeAuthHeaders(
  config: OpenClawConfig,
  targetUrl: string,
  env: NodeJS.ProcessEnv,
) {
  return resolveEdgeAuthHeaders({
    config,
    value: normalizeEdgeAuthHeadersConfig(gatewayEdgeAuthValueForTarget({ config, targetUrl })),
    targetUrl,
    env,
  });
}

/** Select only the explicit interactive credential; never borrow the default/service key. */
async function withInteractiveOperatorDevice(
  connection: ResolvedGatewayConnection,
): Promise<ResolvedGatewayConnection> {
  if (connection.token || connection.password) {
    throw new Error("Choose personal device auth or shared credentials, not both.");
  }
  const identity = await loadInteractiveOperatorDeviceIdentity();
  const credential = await loadStoredOperatorDeviceAuthToken(
    identity,
    connection.deviceAuthScope,
    "read-only",
  );
  if (!credential?.token) {
    throw new Error(
      "This Gateway has no enrolled interactive operator credential. Run openclaw devices enroll for this target first.",
    );
  }
  return {
    ...connection,
    deviceAuth: true,
    deviceIdentity: identity,
    preparedDeviceAuth: credential,
  };
}

/**
 * Preserve a pre-probed Gateway route across an in-process handoff. This path
 * deliberately ignores global config and Gateway env overrides, including
 * credentials, while still applying the normal remote URL safety policy.
 */
export async function resolveBoundGatewayConnection(
  opts: TuiBoundGateway & { config: OpenClawConfig },
): Promise<ResolvedGatewayConnection> {
  const url = buildGatewayConnectionDetails({
    config: opts.config,
    url: opts.url,
    ignoreEnvUrlOverride: true,
  }).url;
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const edgeAuthHeaders = await resolveTuiEdgeAuthHeaders(opts.config, url, process.env);
  const { deviceAuthScope, sshTunnel } = resolveGatewayDeviceAuthRoute({
    config: opts.config,
    url,
    remote: true,
    configuredRemote: opts.configuredRemote,
    tlsFingerprint: opts.tlsFingerprint,
  });
  const connection: ResolvedGatewayConnection = {
    url,
    deviceAuthScope,
    ...(sshTunnel ? { sshTunnel } : {}),
    token: explicitAuth.token,
    password: explicitAuth.password,
    ...(edgeAuthHeaders ? { edgeAuthHeaders } : {}),
    ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {}),
  };
  return opts.deviceAuth ? withInteractiveOperatorDevice(connection) : connection;
}

export async function resolveGatewayConnection(
  opts: TuiGatewayConnectionOptions,
): Promise<ResolvedGatewayConnection> {
  if (opts.deviceAuth && (opts.token || opts.password)) {
    throw new Error("Choose personal device auth or shared credentials, not both.");
  }
  const config = await captureRuntimeConfigAsyncReader()();
  const env = process.env;
  const gatewayAuthMode = config.gateway?.auth?.mode;
  const isRemoteMode = config.gateway?.mode === "remote";

  const urlOverride = resolveGatewayUrlOverride({ gatewayUrl: opts.url, env });
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const hasExplicitGatewayTarget = Boolean(
    urlOverride.url || env.OPENCLAW_GATEWAY_PORT?.trim() || isRemoteMode,
  );
  const resumeMayMatchLocalTarget =
    opts.allowConfiguredAuthForExactTarget === true &&
    urlOverride.source === "cli" &&
    !isRemoteMode &&
    !env.OPENCLAW_GATEWAY_PORT?.trim();
  const activeLocalGatewayPort =
    !hasExplicitGatewayTarget || resumeMayMatchLocalTarget
      ? await readActiveGatewayLockPort()
      : undefined;
  if (
    !opts.deviceAuth &&
    !urlOverride.source &&
    gatewayAuthMode !== "none" &&
    gatewayAuthMode !== "trusted-proxy" &&
    !isRemoteMode
  ) {
    try {
      assertExplicitGatewayAuthModeWhenBothConfigured(config);
    } catch (err) {
      throwGatewayAuthResolutionError(formatErrorMessage(err));
    }
  }
  const bootstrap = await resolveGatewayClientBootstrap({
    config,
    gatewayUrl: urlOverride.source === "cli" ? urlOverride.url : undefined,
    explicitAuth,
    env,
    authPolicy: "interactive",
    ...(opts.deviceAuth ? { skipImplicitAuth: true } : {}),
    allowConfiguredAuthForExactTarget: opts.allowConfiguredAuthForExactTarget,
    suppressEnvAuthFallback: opts.suppressEnvAuthFallback,
    ...(activeLocalGatewayPort ? { localPortOverride: activeLocalGatewayPort } : {}),
    explicitTlsFingerprint: opts.tlsFingerprint,
    allowStoredOriginAuth: hasStoredOriginDeviceAuth,
    overrideAuthErrorHint:
      "Fix: pass --token or --password once to request pairing, approve it in that gateway's Control UI (Settings -> Devices), then retry with the same credential so OpenClaw can store the device token.",
    buildConnectionDetails: buildGatewayConnectionDetails,
  });
  if (!opts.deviceAuth) {
    const hasStoredOriginAuth = Boolean(
      bootstrap.deviceAuthScope && (await hasStoredOriginDeviceAuth(bootstrap.deviceAuthScope)),
    );
    const missingSharedAuth =
      bootstrap.authFailureReason === "Missing gateway auth credentials." ||
      bootstrap.authFailureReason === "Missing gateway auth token." ||
      bootstrap.authFailureReason === "Missing gateway auth password.";
    if (bootstrap.authFailureReason && (!missingSharedAuth || !hasStoredOriginAuth)) {
      // A local Gateway pairs this CLI at startup; without one, a token hint misdirects.
      if (missingSharedAuth && !hasExplicitGatewayTarget && activeLocalGatewayPort === undefined) {
        throw new Error(
          [
            "No Gateway is running on this machine.",
            "Fix: run `openclaw chat` to chat here without a Gateway, or start one with `openclaw gateway`.",
            "To use a Gateway on another machine, run `openclaw tui <Gateway URL>` once with that Gateway's token or password, then approve the pairing request in its Control UI.",
          ].join("\n"),
        );
      }
      throwGatewayAuthResolutionError(bootstrap.authFailureReason);
    }
  }
  const edgeAuthHeaders = await resolveTuiEdgeAuthHeaders(config, bootstrap.url, env);
  const connection: ResolvedGatewayConnection = {
    url: bootstrap.url,
    deviceAuthScope: bootstrap.deviceAuthScope,
    ...(bootstrap.sshTunnel ? { sshTunnel: bootstrap.sshTunnel } : {}),
    ...(edgeAuthHeaders ? { edgeAuthHeaders } : {}),
    ...(bootstrap.tlsFingerprint ? { tlsFingerprint: bootstrap.tlsFingerprint } : {}),
  };
  return opts.deviceAuth
    ? withInteractiveOperatorDevice(connection)
    : { ...connection, token: bootstrap.auth.token, password: bootstrap.auth.password };
}
