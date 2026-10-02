import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  type GatewayConnectAuthSelection,
  type GatewayProtocolCloseContext,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolRequestTiming,
  type GatewayProtocolTiming,
  type ErrorShape,
  type EventFrame,
  type HelloOk,
  selectGatewayConnectAuth,
  shouldRetryGatewayWithDeviceToken,
  isRetryableGatewayStartupUnavailableError,
  resolveGatewayStartupRetryAfterMs,
  resolveSafeTimeoutDelayMs,
  shouldPauseGatewayReconnect,
} from "@openclaw/gateway-client/browser";
import type {
  GatewayScopeUpgrade,
  ScopeUpgradeBinding,
} from "@openclaw/gateway-client/scope-upgrade";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { NativeGatewayAuthUnavailableError } from "../app/native-gateway-auth.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isLoopbackHostname } from "../lib/gateway-locality.ts";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "../lib/nodes/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import {
  BROWSER_WEBSOCKET_SECURITY_ERROR_CODE,
  createBrowserGatewaySocket,
  formatBrowserWebSocketConstructorError,
  probeGatewayReachability,
} from "./gateway-browser-socket.ts";
import { GatewayChatEvents } from "./gateway-chat-events.ts";
import {
  enrichProtocolMismatchDetails,
  resolveGatewayErrorDetailCode,
} from "./gateway-connect-errors.ts";
import {
  buildBrowserGatewayConnectPlan,
  CONTROL_UI_OPERATOR_ROLE,
  CONTROL_UI_OPERATOR_SCOPES,
  type ConnectPlan,
  type GatewayBrowserConnectOptions,
} from "./gateway-connect-plan.ts";
export type { EventFrame as GatewayEventFrame } from "@openclaw/gateway-client/browser";
export { GatewayPayloadLimitError } from "./gateway-browser-socket.ts";

export { resolveGatewayErrorDetailCode, CONTROL_UI_OPERATOR_ROLE };

export class GatewayRequestError extends GatewayProtocolRequestError {
  constructor(error: ErrorShape) {
    const details = enrichProtocolMismatchDetails(error.message, error.details);
    super({
      ...error,
      details,
      message: formatConnectErrorMessage({ message: error.message, details }),
    });
    this.name = "GatewayRequestError";
  }
}

function browserSecureContext(): boolean {
  const win = typeof window !== "undefined" ? window : undefined;
  return win?.isSecureContext === true;
}

function isTrustedRetryEndpoint(url: string): boolean {
  try {
    const gatewayUrl = new URL(url, window.location.href);
    return (
      isLoopbackHostname(gatewayUrl.hostname) ||
      gatewayUrl.host === new URL(window.location.href).host
    );
  } catch {
    return false;
  }
}

export type GatewayControlUiPluginTab = NonNullable<HelloOk["controlUiTabs"]>[number];
export type GatewayControlUiPluginWidgetKind = NonNullable<HelloOk["controlUiWidgetKinds"]>[number];
export type GatewayHelloOk = Omit<HelloOk, "server" | "features" | "snapshot" | "policy"> & {
  server?: Partial<HelloOk["server"]>;
  features?: Partial<HelloOk["features"]>;
  snapshot?: unknown;
  policy?: Partial<HelloOk["policy"]>;
};

export type GatewayBrowserClientOptions = GatewayBrowserConnectOptions & {
  /** Local identity admitted by boot-record; never sent to the server. */
  offlineRecoveryScope?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: EventFrame) => void;
  onClose?: (info: {
    code: number;
    reason: string;
    error?: ErrorShape;
    willRetry: boolean;
    busy?: boolean;
  }) => void;
  onReconnectScheduled?: (delayMs: number) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onRequestTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onConnectTiming?: (timing: GatewayConnectTiming) => void;
  onRecoveryScopeChange?: () => void;
};

export type GatewayEventListener = (evt: EventFrame) => void;

type GatewayConnectTiming = Omit<GatewayProtocolTiming<ConnectPlan>, "plan" | "detail"> & {
  secureContext?: boolean;
  hasDeviceIdentity?: boolean;
  hasDevice?: boolean;
  hasAuthToken?: boolean;
  hasBootstrapToken?: boolean;
  hasDeviceToken?: boolean;
  hasPassword?: boolean;
  errorCode?: string;
};

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;
const STARTUP_RETRY_CLOSE_CODE = 4013;
const BROWSER_WEBSOCKET_CLOSE_CODE = 1006;
const DEFAULT_GATEWAY_TICK_INTERVAL_MS = 30_000;
const MIN_GATEWAY_TICK_WATCH_INTERVAL_MS = 1_000;
function toGatewayErrorInfo(error: GatewayRequestError): ErrorShape {
  const { gatewayCode: code, message, details, retryable, retryAfterMs } = error;
  return { code, message, details, retryable, retryAfterMs };
}

async function deriveLegacyV4RecoveryScope(material: string | undefined): Promise<string> {
  if (!material || typeof crypto === "undefined" || !crypto.subtle) {
    return "";
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return "";
  }
}

export class GatewayBrowserClient {
  private readonly client: GatewayProtocolClient<ConnectPlan>;
  private readonly chatEvents = new GatewayChatEvents((reason) => this.forceReconnect(reason));
  private maxPayloadBytes: number | undefined;
  private scopeUpgradeRuntime: Promise<GatewayScopeUpgrade> | null = null;
  inboundActivitySeq = 0;
  private lastInboundActivityAtMs: number | null = null;
  private maxInboundSilenceMs: number | null = null;
  private tickWatchTimer: ReturnType<typeof setInterval> | null = null;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private nativeAuthAbort: AbortController | null = null;
  private nativeAuthError: GatewayRequestError | null = null;
  // Close/stop advances this generation before another socket can make stale hello work look active.
  private recovery = { value: "", resolved: false, generation: 0 };
  private scopeUpgradeBinding: ScopeUpgradeBinding | null = null;
  private reachabilityProbe: AbortController | null = null;

  constructor(private opts: GatewayBrowserClientOptions) {
    this.client = new GatewayProtocolClient<ConnectPlan>({
      createSocket: (handlers) => {
        this.reachabilityProbe?.abort();
        this.reachabilityProbe = null;
        this.chatEvents.clear();
        this.maxPayloadBytes = undefined;
        return createBrowserGatewaySocket(this.opts.url, handlers, () => this.maxPayloadBytes);
      },
      createRequestId: generateUUID,
      createRequestError: (error) =>
        new GatewayRequestError({
          code: error.code ?? "UNAVAILABLE",
          message: error.message ?? "request failed",
          details: error.details,
          retryable: error.retryable,
          retryAfterMs: error.retryAfterMs,
        }),
      buildConnectPlan: ({ nonce, challengeTs, generation, serverCapabilities }) =>
        this.buildConnectPlan(nonce, challengeTs, generation, serverCapabilities),
      buildConnectParams: (plan) => plan.params,
      onConnectPlanError: (error) => {
        if (this.opts.nativeConnectAuth) {
          this.nativeAuthError =
            error instanceof GatewayRequestError
              ? error
              : new GatewayRequestError({
                  code: "UNAVAILABLE",
                  message: formatUiError(error),
                  retryable: error instanceof NativeGatewayAuthUnavailableError,
                });
          return {
            closeCode: CONNECT_FAILED_CLOSE_CODE,
            closeReason: "native authorization unavailable",
            stop: !this.nativeAuthError.retryable,
          };
        }
        return { closeCode: CONNECT_FAILED_CLOSE_CODE, closeReason: "connect failed" };
      },
      onConnectHello: (hello, context) => this.handleConnectHello(hello, context.plan),
      onHello: (hello) => this.opts.onHello?.(hello),
      onConnectFailure: (error, context) => {
        this.client.recordTiming("failed", context.generation, context.plan, {
          errorCode: error.code,
        });
        return this.handleConnectFailure(error, context.plan);
      },
      resolveClose: (context) => this.resolveClose(context),
      onClose: (context, decision) => {
        this.nativeAuthAbort?.abort();
        this.chatEvents.clear();
        this.recovery = { ...this.recovery, generation: context.generation + 1, resolved: false };
        this.stopTickWatch();
        this.scopeUpgradeBinding = null;
        const error = context.connectFailure?.error ?? this.nativeAuthError;
        this.client.recordTiming("failed", context.generation, undefined, {
          errorCode: error instanceof GatewayRequestError ? error.code : "SOCKET_CLOSED",
        });
        if (decision.notify) {
          const info = {
            code: context.code,
            reason: context.reason,
            error: error instanceof GatewayRequestError ? toGatewayErrorInfo(error) : undefined,
            willRetry: decision.retry,
          };
          if (
            decision.retry &&
            !context.socketOpened &&
            context.code === BROWSER_WEBSOCKET_CLOSE_CODE &&
            !info.error
          ) {
            const probe = new AbortController();
            this.reachabilityProbe = probe;
            const timeout = setTimeout(() => probe.abort(), 1_000);
            void probeGatewayReachability(this.opts.url, probe.signal)
              .then((reachable) => {
                clearTimeout(timeout);
                // A new socket or explicit stop retires this failed upgrade's evidence.
                if (this.reachabilityProbe === probe) {
                  this.reachabilityProbe = null;
                  this.opts.onClose?.({
                    ...info,
                    ...(reachable && !probe.signal.aborted ? { busy: true } : {}),
                  });
                }
              })
              .catch((callbackError: unknown) =>
                console.error("[gateway] close handler error:", callbackError),
              );
          } else {
            this.opts.onClose?.(info);
          }
        }
      },
      onReconnectScheduled: (delayMs) => this.opts.onReconnectScheduled?.(delayMs),
      onSocketFactoryError: (error) => this.handleSocketFactoryError(error),
      onEvent: (event) => this.chatEvents.dispatch(event, this.opts.onEvent),
      onGap: (info) => this.opts.onGap?.(info),
      onActivity: () => {
        this.inboundActivitySeq += 1;
        this.lastInboundActivityAtMs = Date.now();
      },
      onTiming: ({ plan, detail, ...timing }) => {
        this.opts.onConnectTiming?.({
          ...timing,
          ...(plan ? this.connectPlanTimingPayload(plan) : {}),
          ...(detail && typeof detail === "object" ? detail : {}),
        });
      },
      onRequestTiming: (timing) => this.opts.onRequestTiming?.(timing),
      onCallbackError: (label, error) => console.error(`[gateway] ${label} handler error:`, error),
      handshake: { mode: "fallback", timeoutMs: 750 },
      reconnect: { initialMs: 800, multiplier: 1.7, maxMs: 15_000 },
      nowMs: () =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now(),
    });
  }

  get instanceId(): string | undefined {
    return this.opts.instanceId;
  }

  get gatewayUrl(): string {
    return this.opts.url;
  }

  start() {
    this.client.start();
  }

  stop() {
    this.nativeAuthAbort?.abort();
    this.reachabilityProbe?.abort();
    this.reachabilityProbe = null;
    this.chatEvents.clear();
    this.stopTickWatch();
    this.recovery = { ...this.recovery, generation: this.recovery.generation + 1, resolved: false };
    this.client.stop();
    this.cancelScopeUpgrade();
    this.scopeUpgradeBinding = null;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
  }

  get connected() {
    return this.client.connected;
  }

  get needsWakeReconnect() {
    return (
      !this.client.connected ||
      (this.lastInboundActivityAtMs !== null &&
        this.maxInboundSilenceMs !== null &&
        Date.now() - this.lastInboundActivityAtMs >= this.maxInboundSilenceMs)
    );
  }

  /** Changes before a stopped or replaced connection can deliver stale auth work. */
  get connectionGeneration(): number {
    return this.recovery.generation;
  }

  get recoveryScope() {
    return this.recovery.value;
  }

  private offlineStorageRetired = false;

  get offlineRecoveryRetired(): boolean {
    return this.offlineStorageRetired;
  }

  get offlineRecoveryScope(): string | undefined {
    return this.opts.offlineRecoveryScope;
  }

  retireOfflineRecoveryScope(): void {
    this.opts.offlineRecoveryScope = undefined;
    this.offlineStorageRetired = true;
  }

  get recoveryScopeReady() {
    return this.recovery.resolved;
  }

  get scopeUpgradeReady() {
    return this.connected && this.scopeUpgradeBinding !== null;
  }

  private connectPlanTimingPayload(plan: ConnectPlan): Partial<GatewayConnectTiming> {
    return {
      secureContext: browserSecureContext(),
      hasDeviceIdentity: Boolean(plan.deviceIdentity),
      hasDevice: Boolean(plan.params.device),
      hasAuthToken: Boolean(plan.selectedAuth.authToken),
      hasBootstrapToken: Boolean(plan.selectedAuth.authBootstrapToken),
      hasDeviceToken: Boolean(
        plan.selectedAuth.authDeviceToken ?? plan.selectedAuth.resolvedDeviceToken,
      ),
      hasPassword: Boolean(plan.selectedAuth.authPassword),
    };
  }

  private async buildConnectPlan(
    connectNonce: string | null,
    connectChallengeTs: number | null | undefined,
    generation: number,
    serverCapabilities: readonly string[],
  ): Promise<ConnectPlan> {
    this.nativeAuthError = null;
    this.recovery = { ...this.recovery, generation, resolved: false };
    this.nativeAuthAbort?.abort();
    this.nativeAuthAbort = new AbortController();
    const plan = await buildBrowserGatewayConnectPlan({
      opts: this.opts,
      connectNonce,
      connectChallengeTs,
      generation,
      serverCapabilities,
      nativeSignal: this.nativeAuthAbort.signal,
      selectAuth: (input) => this.selectConnectAuth(input),
      onDeviceIdentityReady: (hasDeviceIdentity) => {
        this.client.recordTiming("device-identity-ready", generation, undefined, {
          secureContext: browserSecureContext(),
          hasDeviceIdentity,
        });
      },
    });
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    return plan;
  }

  private handleConnectHello(hello: GatewayHelloOk, plan: ConnectPlan) {
    // Publish this connection's identity before listeners can capture recovery intent.
    // A legacy hello must not retain its predecessor while its digest is pending.
    this.recovery.value = hello.auth?.recoveryScope ?? "";
    // Replace retained identity before consumers can act on a different account.
    this.opts.offlineRecoveryScope = hello.auth?.recoveryScope;
    this.offlineStorageRetired = false;
    this.maxPayloadBytes = hello.policy?.maxPayload;
    this.startTickWatch(hello);
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.opts.bootstrapToken = undefined;
    this.opts.bootstrapProfile = undefined;
    this.scopeUpgradeBinding = plan.deviceIdentity && {
      clientId: plan.params.client.id,
      deviceId: plan.deviceIdentity.deviceId,
      role: plan.params.role ?? CONTROL_UI_OPERATOR_ROLE,
    };
    if (hello?.auth?.deviceToken && plan.deviceIdentity) {
      const role = hello.auth.role ?? plan.params.role ?? CONTROL_UI_OPERATOR_ROLE;
      const scopes =
        role === plan.params.role && hello.auth.deviceToken === plan.selectedAuth.storedToken
          ? (plan.selectedAuth.storedScopes ?? hello.auth.scopes ?? [])
          : (hello.auth.scopes ?? []);
      storeDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        gatewayUrl: this.opts.url,
        role,
        token: hello.auth.deviceToken,
        scopes,
      });
    }
    void this.resolveRecoveryScope(hello, plan);
  }

  private async resolveRecoveryScope(hello: GatewayHelloOk, plan: ConnectPlan) {
    const serverScope = hello.auth?.recoveryScope;
    const legacyScope = await deriveLegacyV4RecoveryScope(
      hello.auth?.deviceToken ??
        plan.selectedAuth.authDeviceToken ??
        plan.selectedAuth.resolvedDeviceToken ??
        plan.selectedAuth.authToken,
    );
    const migrateRecoveryScope =
      serverScope && hello.auth?.recoveryMigrationAllowed === true && legacyScope
        ? (await import("../lib/sessions/session-placement-recovery-migration.runtime.ts")).default
        : undefined;
    if (plan.generation !== this.recovery.generation || !this.client.connected) {
      return;
    }
    migrateRecoveryScope?.(this.opts.url, legacyScope, serverScope!);
    this.recovery.value = serverScope ?? legacyScope;
    this.recovery.resolved = true;
    this.opts.offlineRecoveryScope = this.recovery.value || undefined;
    this.opts.onRecoveryScopeChange?.();
  }

  private startTickWatch(hello: GatewayHelloOk): void {
    this.stopTickWatch();
    const advertisedTickIntervalMs = hello.policy?.tickIntervalMs;
    // Gateway policy is remote input; use the shared timer clamp so an
    // oversized interval cannot wrap into a resource-exhausting hot loop.
    const tickIntervalMs = resolveSafeTimeoutDelayMs(
      typeof advertisedTickIntervalMs === "number" &&
        Number.isFinite(advertisedTickIntervalMs) &&
        advertisedTickIntervalMs > 0
        ? advertisedTickIntervalMs
        : DEFAULT_GATEWAY_TICK_INTERVAL_MS,
      { minMs: MIN_GATEWAY_TICK_WATCH_INTERVAL_MS },
    );
    this.maxInboundSilenceMs = tickIntervalMs * 2;
    this.lastInboundActivityAtMs = Date.now();
    this.tickWatchTimer = setInterval(() => {
      // Preserve long-running requests while real Gateway heartbeats arrive;
      // only a silent socket should enter the shared reconnect lifecycle.
      if (this.connected && this.needsWakeReconnect) {
        this.forceReconnect("tick timeout");
      }
    }, tickIntervalMs);
  }

  private stopTickWatch(): void {
    if (this.tickWatchTimer !== null) {
      clearInterval(this.tickWatchTimer);
      this.tickWatchTimer = null;
    }
    this.lastInboundActivityAtMs = null;
    this.maxInboundSilenceMs = null;
  }

  private handleConnectFailure(err: GatewayProtocolRequestError, plan: ConnectPlan) {
    const connectErrorCode =
      err instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(err) : null;
    if (
      shouldRetryGatewayWithDeviceToken({
        retryBudgetUsed: this.deviceTokenRetryBudgetUsed,
        currentDeviceToken: plan.selectedAuth.authDeviceToken,
        explicitToken: plan.explicitGatewayToken,
        storedToken: plan.selectedAuth.storedToken,
        trustedEndpoint: Boolean(plan.deviceIdentity) && isTrustedRetryEndpoint(this.opts.url),
        errorDetails: err instanceof GatewayRequestError ? err.details : undefined,
      })
    ) {
      this.pendingDeviceTokenRetry = true;
      this.deviceTokenRetryBudgetUsed = true;
    }
    const usedStoredDeviceToken =
      Boolean(plan.selectedAuth.storedToken) &&
      (plan.selectedAuth.resolvedDeviceToken === plan.selectedAuth.storedToken ||
        plan.selectedAuth.authDeviceToken === plan.selectedAuth.storedToken);
    if (
      usedStoredDeviceToken &&
      plan.deviceIdentity &&
      connectErrorCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
    ) {
      clearDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        gatewayUrl: this.opts.url,
        role: plan.params.role ?? CONTROL_UI_OPERATOR_ROLE,
      });
    }
    const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(err);
    if (isRetryableGatewayStartupUnavailableError(err)) {
      return {
        closeCode: STARTUP_RETRY_CLOSE_CODE,
        closeReason: "gateway starting",
        reconnectDelayMs: startupRetryAfterMs ?? undefined,
      };
    }
    return { closeCode: CONNECT_FAILED_CLOSE_CODE, closeReason: "connect failed" };
  }

  private selectConnectAuth(params: {
    role: string;
    deviceId: string;
  }): GatewayConnectAuthSelection {
    const storedEntry = loadDeviceAuthToken({
      deviceId: params.deviceId,
      gatewayUrl: this.opts.url,
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
      token: this.opts.token,
      bootstrapToken: this.opts.bootstrapToken,
      password: this.opts.password,
      storedToken: storedTokenCanRead ? storedEntry?.token : undefined,
      storedScopes: storedEntry?.scopes,
      pendingDeviceTokenRetry: this.pendingDeviceTokenRetry,
      trustedDeviceTokenRetry: isTrustedRetryEndpoint(this.opts.url),
      preferBootstrapToken: true,
    });
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    return this.chatEvents.request<T>(this.client, method, params, options);
  }

  async requestScopeUpgrade(options: { onPending?: (requestId: string) => void } = {}) {
    const binding = this.scopeUpgradeBinding;
    if (!this.connected || !binding) {
      throw new Error("scope upgrade requires a connected browser device");
    }
    const runtime = await this.loadScopeUpgradeRuntime();
    return runtime.requestScopeUpgrade({
      binding,
      scopes: CONTROL_UI_OPERATOR_SCOPES,
      onPending: options.onPending,
    });
  }

  cancelScopeUpgrade(): void {
    void this.scopeUpgradeRuntime
      ?.then((runtime) => runtime.cancelScopeUpgrade())
      .catch(() => undefined);
  }

  private loadScopeUpgradeRuntime(): Promise<GatewayScopeUpgrade> {
    return (this.scopeUpgradeRuntime ??= import("./gateway-scope-upgrade.runtime.ts")
      .then(({ createGatewayScopeUpgradeRuntime }) =>
        createGatewayScopeUpgradeRuntime({
          gatewayUrl: this.opts.url,
          request: (method, params, options) => this.request(method, params, options),
          reconnect: () => this.forceReconnect("scope upgrade approved"),
        }),
      )
      .catch((error: unknown) => {
        this.scopeUpgradeRuntime = null;
        throw error;
      }));
  }

  addEventListener(listener: GatewayEventListener): () => void {
    return this.client.addEventListener((event) => this.chatEvents.dispatch(event, listener));
  }

  /** Drops a stale socket; the shared reconnect supervisor owns recovery. */
  forceReconnect(reason: string): void {
    this.client.closeSocket(4000, reason);
  }

  private resolveClose(context: GatewayProtocolCloseContext) {
    if (this.nativeAuthError) {
      return {
        retry: this.nativeAuthError.retryable,
        notify: true,
        pendingError: this.nativeAuthError,
      };
    }
    const error = context.connectFailure?.error;
    const startupDelay = context.connectFailure?.reconnectDelayMs;
    if (startupDelay !== undefined) {
      return { retry: true, notify: true, reconnectDelayMs: startupDelay, pendingError: error };
    }
    const connectError =
      error instanceof GatewayRequestError ? toGatewayErrorInfo(error) : undefined;
    const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
    // This decision drives both scheduling and the store's reconnect rendering.
    const retry =
      connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
        ? this.pendingDeviceTokenRetry
        : !shouldPauseGatewayReconnect({
            details: connectError?.details,
            protocolMismatchIsTerminal: true,
          });
    return { retry, notify: true, pendingError: error };
  }

  private handleSocketFactoryError(error: Error): void {
    const formatted = formatBrowserWebSocketConstructorError(error, this.opts.url);
    this.pendingDeviceTokenRetry = false;
    try {
      this.opts.onClose?.({
        code: BROWSER_WEBSOCKET_CLOSE_CODE,
        reason:
          formatted.code === BROWSER_WEBSOCKET_SECURITY_ERROR_CODE
            ? "security error"
            : "websocket error",
        error: formatted,
        willRetry: false,
      });
    } catch (callbackError) {
      console.error("[gateway] close handler error:", callbackError);
    }
  }
}
