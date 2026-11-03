import {
  buildGatewayConnectAuth,
  buildDeviceAuthPayload,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  resolveGatewayConnectScopes,
  resolveModelCatalogConnect,
  selectGatewayConnectAuth,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ConnectParams,
  type GatewayClientMode,
  type GatewayClientName,
  type GatewayConnectAuthSelection,
  type GatewayProtocolRequestTiming,
  type EventFrame,
  type HelloOk,
} from "@openclaw/gateway-client/browser";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT,
  type ControlUiBootstrapProfileHint,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
} from "../../../src/shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import type {
  NativeGatewayAuthorization,
  NativeGatewayConnectAuth,
} from "../app/native-gateway-auth.ts";
import { isNativeMobileHost } from "../app/native-web-chrome.ts";
import { i18n } from "../i18n/index.ts";
import { bytesToHex } from "../lib/bytes-hex.ts";
import {
  loadDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  signDevicePayload,
} from "../lib/nodes/index.ts";
import { isTrustedRetryEndpoint, type GatewayBrowserCloseInfo } from "./gateway-connect-errors.ts";

export type GatewayControlUiPluginTab = NonNullable<HelloOk["controlUiTabs"]>[number];
export type GatewayControlUiPluginWidgetKind = NonNullable<HelloOk["controlUiWidgetKinds"]>[number];
export type GatewayHelloOk = Omit<HelloOk, "server" | "features" | "snapshot" | "policy"> & {
  server?: Partial<HelloOk["server"]>;
  features?: Partial<HelloOk["features"]>;
  snapshot?: Partial<HelloOk["snapshot"]>;
  policy?: Partial<HelloOk["policy"]>;
};

export type GatewayBrowserClientOptions = GatewayBrowserConnectOptions & {
  /** Local identity admitted by boot-record; never sent to the server. */
  offlineRecoveryScope?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: EventFrame) => void;
  onClose?: (info: GatewayBrowserCloseInfo) => void;
  onConnecting?: () => void;
  onReconnectScheduled?: (delayMs: number) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onRequestTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onRecoveryScopeChange?: () => void;
};

export type GatewayEventListener = (evt: EventFrame) => void;

export type GatewayBrowserConnectOptions = {
  /** Keep complete roster messages for event listeners already present at connect. */
  includeSessionMessageBodies?: boolean;
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

export async function deriveLegacyV4RecoveryScope(material: string | undefined): Promise<string> {
  if (!material || typeof crypto === "undefined" || !crypto.subtle) {
    return "";
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return bytesToHex(new Uint8Array(digest));
  } catch {
    return "";
  }
}

export function selectBrowserGatewayConnectAuth(
  opts: GatewayBrowserConnectOptions,
  params: { role: string; deviceId: string },
  remoteIngress: boolean,
  pendingDeviceTokenRetry: boolean,
): GatewayConnectAuthSelection {
  if (remoteIngress) {
    return {};
  }
  const storedEntry = loadDeviceAuthToken({
    deviceId: params.deviceId,
    gatewayUrl: opts.url,
    role: params.role,
  });
  const storedScopes = storedEntry?.scopes ?? [];
  const storedTokenCanRead =
    params.role !== CONTROL_UI_OPERATOR_ROLE ||
    roleScopesAllow({
      role: params.role,
      requestedScopes: ["operator.sessions.read"],
      allowedScopes: storedScopes,
    });
  return selectGatewayConnectAuth({
    token: opts.token,
    bootstrapToken: opts.bootstrapToken,
    password: opts.password,
    storedToken: storedTokenCanRead ? storedEntry?.token : undefined,
    storedScopes: storedEntry?.scopes,
    pendingDeviceTokenRetry,
    trustedDeviceTokenRetry: isTrustedRetryEndpoint(opts.url),
    preferBootstrapToken: true,
  });
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
      ...(!nativeAuth && opts.includeSessionMessageBodies
        ? { includeSessionMessageBodies: true }
        : {}),
      // Tests bind these compact wire literals to the canonical capability registry.
      ...resolveModelCatalogConnect({
        // Reading the target reserves its bootstrap wait, so negotiate support first.
        get modelCatalog() {
          return opts.modelCatalog;
        },
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
          "chat-queue-status",
          "hello-health-on-demand",
          "health-summary",
          "hello-presence-self",
          "session-scoped-events",
          "presence-deltas",
          ...(!nativeAuth
            ? ["session-row-deltas", "session-event-field-refs", "roster-message-bodies-optional"]
            : []),
          "inline-widgets",
          "model-selection-policy",
          "model-wait-status",
          ...(!isNativeMobileHost() ? ["ui-agent-github-settings", "ui-commands"] : []),
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
