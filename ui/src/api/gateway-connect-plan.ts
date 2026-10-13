import {
  buildGatewayConnectAuth,
  buildDeviceAuthPayload,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  resolveGatewayConnectScopes,
  resolveModelCatalogConnect,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ConnectParams,
  type GatewayClientMode,
  type GatewayClientName,
  type GatewayConnectAuthSelection,
} from "@openclaw/gateway-client/browser";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT,
  type ControlUiBootstrapProfileHint,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
} from "../../../src/shared/device-bootstrap-profile.js";
import type {
  NativeGatewayAuthorization,
  NativeGatewayConnectAuth,
} from "../app/native-gateway-auth.ts";
import { i18n } from "../i18n/index.ts";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "../lib/nodes/index.ts";

export type GatewayBrowserConnectOptions = {
  url: string;
  nativeConnectAuth?: NativeGatewayConnectAuth;
  token?: string;
  bootstrapToken?: string;
  bootstrapProfile?: ControlUiBootstrapProfileHint;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  clientBuildId?: string;
  platform?: string;
  deviceFamily?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  scopes?: string[];
  modelCatalog?: ConnectParams["modelCatalog"];
};

export const CONTROL_UI_OPERATOR_ROLE = "operator";

export const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

export type ConnectPlan = {
  generation: number;
  params: ConnectParams;
  explicitGatewayToken?: string;
  selectedAuth: GatewayConnectAuthSelection;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
};

function browserDeviceFamily(): string | undefined {
  if (navigator.platform !== "MacIntel") {
    return undefined;
  }
  // Desktop-mode iPads share the Mac platform string; keep that pairing identity unchanged.
  return navigator.maxTouchPoints > 1 || /iPad/u.test(navigator.userAgent) ? "iPad" : "Mac";
}

export async function buildBrowserGatewayConnectPlan({
  opts,
  connectNonce,
  connectChallengeTs,
  generation,
  serverCapabilities,
  nativeSignal,
  selectAuth,
}: {
  opts: GatewayBrowserConnectOptions;
  connectNonce: string | null;
  connectChallengeTs: number | null | undefined;
  generation: number;
  serverCapabilities: readonly string[];
  nativeSignal: AbortSignal;
  selectAuth: (input: { role: string; deviceId: string }) => GatewayConnectAuthSelection;
}): Promise<ConnectPlan> {
  const role = CONTROL_UI_OPERATOR_ROLE;
  // Gateway Coupling makes the connect handshake the only version-skew gate.
  // A configured build identity must never be omitted or downgraded.
  // Browsers know their own zone, so presence gets a location hint that survives
  // proxies, tunnels, and CGNAT ranges where the connecting IP tells us nothing.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  let client: ConnectParams["client"] = {
    id: opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
    version: opts.clientVersion ?? "control-ui",
    buildId: opts.clientBuildId,
    platform: opts.platform ?? navigator.platform ?? "web",
    deviceFamily:
      opts.deviceFamily ?? (opts.platform === undefined ? browserDeviceFamily() : undefined),
    mode: opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
    instanceId: opts.instanceId,
    ...(timeZone ? { timeZone } : {}),
  };
  const explicitGatewayToken = opts.token?.trim() || undefined;
  const explicitPassword = opts.password?.trim() || undefined;

  // Pure-JS Ed25519 signing keeps device identity working on any origin,
  // including plain-HTTP dashboards without crypto.subtle; only a failed
  // mint (no WebCrypto RNG) degrades to a device-less connect.
  let selectedAuth: GatewayConnectAuthSelection = {
    authToken: explicitGatewayToken,
    authPassword: explicitPassword,
  };
  let nativeAuth: NativeGatewayAuthorization | undefined;
  if (opts.nativeConnectAuth) {
    if (
      !connectNonce ||
      typeof connectChallengeTs !== "number" ||
      !Number.isSafeInteger(connectChallengeTs)
    ) {
      throw new Error("The Gateway did not provide a valid native authentication challenge.");
    }
    nativeAuth = await opts.nativeConnectAuth({
      gatewayUrl: opts.url,
      nonce: connectNonce,
      signedAt: connectChallengeTs,
      signal: nativeSignal,
    });
    nativeSignal.throwIfAborted();
    client = {
      ...nativeAuth.client,
      buildId: opts.clientBuildId,
      ...(timeZone ? { timeZone } : {}),
    };
    selectedAuth = {
      authToken: nativeAuth.auth.token,
      authPassword: nativeAuth.auth.password,
      resolvedDeviceToken: nativeAuth.auth.deviceToken,
    };
  }
  // Native devices retain their signing key and grants in the app. Never mint
  // a browser identity or persist hello credentials for this connection path.
  const deviceIdentity = nativeAuth ? null : await loadOrCreateDeviceIdentity().catch(() => null);
  if (deviceIdentity) {
    selectedAuth = selectAuth({ role, deviceId: deviceIdentity.deviceId });
  }
  // The single secret input uses token; retain explicit native passwords and
  // copy only selected shared auth, never bootstrap or device credentials.
  if (!nativeAuth) {
    selectedAuth.authPassword ??= selectedAuth.authToken;
  }
  const scopes =
    nativeAuth?.scopes ??
    resolveGatewayConnectScopes({
      requestedScopes: selectedAuth.authBootstrapToken
        ? opts.bootstrapProfile === CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT
          ? [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]
          : [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]
        : opts.scopes,
      usingStoredDeviceToken: selectedAuth.usingStoredDeviceToken,
      storedScopes: selectedAuth.storedScopes,
      defaultScopes: CONTROL_UI_OPERATOR_SCOPES,
    });
  let device = nativeAuth?.device;
  if (deviceIdentity) {
    if (connectChallengeTs === null) {
      throw new Error("gateway connect challenge timestamp invalid");
    }
    // The Control UI alone supports pre-challenge Gateways; that timeout fallback has no server time.
    const signedAt = connectChallengeTs ?? Date.now();
    const nonce = connectNonce ?? "";
    const payload = buildDeviceAuthPayload({
      deviceId: deviceIdentity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role,
      scopes,
      signedAtMs: signedAt,
      token: selectedAuth.signatureToken ?? null,
      nonce,
    });
    const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
    device = {
      id: deviceIdentity.deviceId,
      publicKey: deviceIdentity.publicKey,
      signature,
      signedAt,
      nonce,
    };
  }
  return {
    generation,
    params: {
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      role,
      scopes,
      device,
      // Tests bind these compact wire literals to the canonical capability registry.
      ...resolveModelCatalogConnect({
        modelCatalog: opts.modelCatalog,
        serverCapabilities,
        caps: [
          "agent-kind",
          "approvals",
          "task-suggestions",
          "terminal-offset-seq",
          "terminal-session-metadata",
          "terminal-upload-path-style",
          "tool-events",
          "chat-only-assistant-text",
          "session-scoped-events",
          "inline-widgets",
          "model-selection-policy",
          "ui-commands",
          "ultrafast",
          "usage-refreshing",
        ],
      }),
      auth: nativeAuth?.auth ?? buildGatewayConnectAuth(selectedAuth),
      userAgent: navigator.userAgent,
      locale: i18n.getRequestedLocale(),
    },
    explicitGatewayToken: nativeAuth ? undefined : explicitGatewayToken,
    selectedAuth,
    deviceIdentity,
  };
}
