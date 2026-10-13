import {
  ConnectErrorDetailCodes,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  type GatewayConnectAuthSelection,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolRequestTiming,
  type EventFrame,
  type HelloOk,
  selectGatewayConnectAuth,
  shouldRetryGatewayWithDeviceToken,
  resolveGatewayStartupRetryAfterMs,
  readPairingConnectErrorDetails,
} from "@openclaw/gateway-client/browser";
import type {
  GatewayScopeUpgrade,
  ScopeUpgradeBinding,
} from "@openclaw/gateway-client/scope-upgrade";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { NativeGatewayAuthUnavailableError } from "../app/native-gateway-auth.ts";
import { isRemoteControlUiIngress } from "../app/remote-ingress.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "../lib/nodes/index.ts";
import { listSessionPlacementRecoveryStorageKeys } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import { generateUUID } from "../lib/uuid.ts";
import { probeGatewayReachability } from "./gateway-browser-socket.ts";
import * as gatewaySocket from "./gateway-browser-socket.ts";
import { GatewayChatEvents } from "./gateway-chat-events.ts";
import {
  GatewayRequestError,
  isTrustedRetryEndpoint,
  notifyBrowserWebSocketError,
  resolveBrowserGatewayClose,
  resolveGatewayErrorDetailCode,
  toGatewayErrorInfo,
  type GatewayBrowserCloseInfo,
} from "./gateway-connect-errors.ts";
import {
  buildBrowserGatewayConnectPlan,
  deriveLegacyV4RecoveryScope,
  CONTROL_UI_OPERATOR_ROLE,
  CONTROL_UI_OPERATOR_SCOPES,
  type ConnectPlan,
  type GatewayBrowserConnectOptions,
} from "./gateway-connect-plan.ts";
import { resolveMaxInboundSilenceMs } from "./gateway-heartbeat-policy.ts";
import { requestTalkCatalog } from "./gateway-talk-catalog.ts";
import { GatewayPayloadLimitError, normalizeGatewayPayloadError } from "./gateway-payload-error.ts";
export type { EventFrame as GatewayEventFrame } from "@openclaw/gateway-client/browser";

export { GatewayRequestError, resolveGatewayErrorDetailCode, CONTROL_UI_OPERATOR_ROLE };
export { GatewayPayloadLimitError };

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

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;
const STARTUP_RETRY_CLOSE_CODE = 4013;
const BROWSER_WEBSOCKET_CLOSE_CODE = 1006;
const INBOUND_SILENCE_CHECK_INTERVAL_MS = 1_000;
// Unanswered sends need a quicker liveness check even after their requests time out.
const UNANSWERED_REQUEST_SILENCE_MS = 5_000;
const INBOUND_SILENCE_PROBE_TIMEOUT_MS = 10_000;
const STALE_OPENING_MS = 8_000;

export class GatewayBrowserClient {
  private readonly client: GatewayProtocolClient<ConnectPlan>;
  private connectDispatch = Promise.withResolvers<boolean>();
  private readonly initialConnectDispatch = this.connectDispatch.promise.then(() => undefined);
  private readonly chatEvents = new GatewayChatEvents((reason) => this.forceReconnect(reason));
  private scopeUpgradeRuntime: Promise<GatewayScopeUpgrade> | null = null;
  private connectionHello: GatewayHelloOk | null = null;
  private lastInboundActivityAtMs: number | null = null;
  private firstUnansweredRequestAtMs: number | null = null;
  private maxInboundSilenceMs: number | null = null;
  private inboundSilenceTimer: ReturnType<typeof setInterval> | null = null;
  private inboundSilenceProbe: {
    activityAtMs: number;
    deadlineMs: number;
    abort: AbortController;
  } | null = null;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private readonly remoteIngress = isRemoteControlUiIngress();
  private nativeAuthAbort: AbortController | null = null;
  private nativeAuthError: GatewayRequestError | null = null;
  // Close/stop advances this generation before another socket can make stale hello work look active.
  private recovery = { value: "", resolved: false, generation: 0 };
  private scopeUpgradeBinding: ScopeUpgradeBinding | null = null;
  private reachabilityProbe: AbortController | null = null;
  private pendingPairing: { requestId: string; deviceId: string } | null = null;
  private pairingFailure: GatewayRequestError | null = null;
  private catalogRetryAbort = new AbortController();
  private openingStartedAtMs = 0;
  private startupRetryPending = false;

  constructor(private opts: GatewayBrowserClientOptions) {
    if (this.remoteIngress) {
      // The ingress owns admission and supplies its scope ceiling for an empty request.
      Object.assign(this.opts, {
        token: undefined,
        password: undefined,
        bootstrapToken: undefined,
        bootstrapProfile: undefined,
        nativeConnectAuth: undefined,
        scopes: [],
      });
    }
    this.client = new GatewayProtocolClient<ConnectPlan>({
      createSocket: (handlers) => {
        this.openingStartedAtMs = Date.now();
        this.startupRetryPending = false;
        this.opts.onConnecting?.();
        this.catalogRetryAbort.abort();
        this.catalogRetryAbort = new AbortController();
        this.connectionHello = null;
        this.pendingPairing = null;
        this.pairingFailure = null;
        this.reachabilityProbe?.abort();
        this.reachabilityProbe = null;
        this.chatEvents.clear();
        return gatewaySocket.createBrowserGatewaySocket(this.opts.url, handlers);
      },
      createRequestId: generateUUID,
      validateRequestFrame: (frame, method, isPreAuth) => {
        try {
          gatewaySocket.validateGatewayRequestFrame(
            frame,
            method,
            this.client.maxPayloadBytes,
            isPreAuth,
          );
        } catch (error) {
          throw normalizeGatewayPayloadError(error);
        }
      },
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
      onConnectFailure: (error, context) => this.handleConnectFailure(error, context.plan),
      resolveClose: (context) =>
        resolveBrowserGatewayClose(
          context,
          this.nativeAuthError,
          this.pairingFailure,
          this.pendingDeviceTokenRetry,
        ),
      onClose: (context, decision) => {
        this.retireConnectDispatch();
        this.catalogRetryAbort.abort();
        this.connectionHello = null;
        this.nativeAuthAbort?.abort();
        this.chatEvents.clear();
        this.recovery = { ...this.recovery, generation: context.generation + 1, resolved: false };
        this.clearInboundActivity();
        this.scopeUpgradeBinding = null;
        const error = this.pairingFailure ?? context.connectFailure?.error ?? this.nativeAuthError;
        this.pendingPairing = null;
        if (decision.notify) {
          const info = {
            code: context.code,
            reason: context.reason,
            error: error instanceof GatewayRequestError ? toGatewayErrorInfo(error) : undefined,
            willRetry: decision.retry,
          };
          // Known failures must reach the UI before a retry can retire the liveness probe.
          if (
            decision.retry &&
            !context.socketOpened &&
            context.code === BROWSER_WEBSOCKET_CLOSE_CODE &&
            !context.reason &&
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
      onSocketFactoryError: (error) => {
        this.retireConnectDispatch();
        this.pendingDeviceTokenRetry = false;
        notifyBrowserWebSocketError(error, this.opts);
      },
      onEvent: (event) => {
        if (this.pendingPairing) {
          this.handlePairingResolution(event);
          return;
        }
        this.chatEvents.dispatch(event, this.opts.onEvent);
      },
      onGap: (info) => this.opts.onGap?.(info),
      onActivity: () => {
        this.lastInboundActivityAtMs = Date.now();
        this.firstUnansweredRequestAtMs = null;
      },
      onRequestTiming: (timing) => this.opts.onRequestTiming?.(timing),
      onTiming: ({ phase }) => {
        if (phase === "request-sent") {
          this.connectDispatch.resolve(true);
        }
      },
      onCallbackError: (label, error) => console.error(`[gateway] ${label} handler error:`, error),
      handshake: { mode: "require-challenge", timeoutMs: DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS },
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
    this.retireConnectDispatch();
    this.catalogRetryAbort.abort();
    this.connectionHello = null;
    this.nativeAuthAbort?.abort();
    this.reachabilityProbe?.abort();
    this.reachabilityProbe = null;
    this.chatEvents.clear();
    this.clearInboundActivity();
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

  private retireConnectDispatch() {
    this.connectDispatch.resolve(false);
    this.connectDispatch = Promise.withResolvers<boolean>();
  }

  /** One connection's dispatch receipt; replacement retires pending read pipelines. */
  get connectSent(): Promise<boolean> {
    return this.connectDispatch.promise;
  }

  /** Cached views can mount during the first handshake's network wait. */
  get initialConnectSent(): Promise<void> {
    return this.initialConnectDispatch;
  }

  get auth() {
    return this.connectionHello?.auth ?? null;
  }

  get hello() {
    return this.connectionHello;
  }

  get needsWakeReconnect() {
    // Replacing an in-flight upgrade drops it before a busy Gateway can answer.
    if (
      this.pendingPairing ||
      this.pairingFailure ||
      this.startupRetryPending ||
      this.client.opening
    ) {
      return false;
    }
    return (
      !this.client.connected ||
      (this.lastInboundActivityAtMs !== null &&
        this.maxInboundSilenceMs !== null &&
        Date.now() - this.lastInboundActivityAtMs >= this.maxInboundSilenceMs)
    );
  }

  /** Fresh HTTP evidence may retire a lost upgrade, never an opened or admitted socket. */
  get needsReachabilityReconnect(): boolean {
    if (this.pendingPairing || this.pairingFailure || this.startupRetryPending) {
      return false;
    }
    return this.client.opening
      ? Date.now() - this.openingStartedAtMs >= STALE_OPENING_MS
      : !this.client.connected;
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
    });
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    return plan;
  }

  private handleConnectHello(hello: GatewayHelloOk, plan: ConnectPlan) {
    this.connectionHello = hello;
    // Publish this connection's identity before listeners can capture recovery intent.
    // A legacy hello must not retain its predecessor while its digest is pending.
    this.recovery.value = hello.auth?.recoveryScope ?? "";
    // Replace retained identity before consumers can act on a different account.
    this.opts.offlineRecoveryScope = hello.auth?.recoveryScope;
    this.offlineStorageRetired = false;
    this.initializeInboundActivity(hello);
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.opts.bootstrapToken = undefined;
    this.opts.bootstrapProfile = undefined;
    this.scopeUpgradeBinding =
      !this.remoteIngress && plan.deviceIdentity
        ? {
            clientId: plan.params.client.id,
            deviceId: plan.deviceIdentity.deviceId,
            role: plan.params.role ?? CONTROL_UI_OPERATOR_ROLE,
          }
        : null;
    if (!this.remoteIngress && hello?.auth?.deviceToken && plan.deviceIdentity) {
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
      this.remoteIngress
        ? undefined
        : (hello.auth?.deviceToken ??
            plan.selectedAuth.authDeviceToken ??
            plan.selectedAuth.resolvedDeviceToken ??
            plan.selectedAuth.authToken),
    );
    const migrateRecoveryScope =
      serverScope &&
      hello.auth?.recoveryMigrationAllowed === true &&
      legacyScope &&
      listSessionPlacementRecoveryStorageKeys(this.opts.url, legacyScope).length > 0
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

  private initializeInboundActivity(hello: GatewayHelloOk): void {
    this.maxInboundSilenceMs = resolveMaxInboundSilenceMs(hello.policy?.tickIntervalMs);
    this.lastInboundActivityAtMs = Date.now();
    this.firstUnansweredRequestAtMs = null;
    this.inboundSilenceTimer = setInterval(
      () => this.checkInboundSilence(),
      INBOUND_SILENCE_CHECK_INTERVAL_MS,
    );
  }

  private checkInboundSilence(): void {
    const lastActivityAtMs = this.lastInboundActivityAtMs;
    if (!this.connected || lastActivityAtMs === null || this.maxInboundSilenceMs === null) {
      return;
    }
    // Hidden tabs rely on page activation recovery, not throttled probe deadlines.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      this.clearInboundSilenceProbe();
      return;
    }
    const now = Date.now();
    const probe = this.inboundSilenceProbe;
    if (probe && lastActivityAtMs === probe.activityAtMs) {
      if (now >= probe.deadlineMs) {
        this.clearInboundActivity();
        this.forceReconnect("inbound silence probe timeout");
      }
      return;
    }
    this.clearInboundSilenceProbe();
    if (
      now - lastActivityAtMs < this.maxInboundSilenceMs &&
      (this.firstUnansweredRequestAtMs === null ||
        now - this.firstUnansweredRequestAtMs < UNANSWERED_REQUEST_SILENCE_MS)
    ) {
      return;
    }
    const abort = new AbortController();
    this.inboundSilenceProbe = {
      activityAtMs: lastActivityAtMs,
      deadlineMs: now + INBOUND_SILENCE_PROBE_TIMEOUT_MS,
      abort,
    };
    // Health is scope-independent; avoid active integration probes. Any inbound
    // frame, including an error response, proves liveness at the next check.
    void this.client
      .request(
        "health",
        { probe: false },
        { timeoutMs: INBOUND_SILENCE_PROBE_TIMEOUT_MS, signal: abort.signal },
      )
      .catch(() => undefined);
  }

  private clearInboundSilenceProbe(): void {
    const probe = this.inboundSilenceProbe;
    this.inboundSilenceProbe = null;
    probe?.abort.abort();
  }

  private clearInboundActivity(): void {
    if (this.inboundSilenceTimer !== null) {
      clearInterval(this.inboundSilenceTimer);
      this.inboundSilenceTimer = null;
    }
    this.clearInboundSilenceProbe();
    this.lastInboundActivityAtMs = null;
    this.firstUnansweredRequestAtMs = null;
    this.maxInboundSilenceMs = null;
  }

  private handleConnectFailure(err: GatewayProtocolRequestError, plan: ConnectPlan) {
    const pairing = readPairingConnectErrorDetails(err.details);
    if (
      err instanceof GatewayRequestError &&
      pairing?.waitForResolution &&
      pairing.requestId &&
      pairing.deviceId &&
      pairing.deviceId === plan.deviceIdentity?.deviceId
    ) {
      this.pendingPairing = { requestId: pairing.requestId, deviceId: pairing.deviceId };
      this.opts.onClose?.({
        code: CONNECT_FAILED_CLOSE_CODE,
        reason: "pairing approval pending",
        error: toGatewayErrorInfo(err),
        willRetry: true,
      });
      return {
        closeCode: CONNECT_FAILED_CLOSE_CODE,
        closeReason: "pairing approval pending",
        keepOpen: true,
      };
    }
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
    if (startupRetryAfterMs !== null) {
      this.startupRetryPending = true;
      return {
        closeCode: STARTUP_RETRY_CLOSE_CODE,
        closeReason: "gateway starting",
        // Startup overrides bypass transport backoff; spread tabs without retrying before the hint.
        reconnectDelayMs: Math.ceil(startupRetryAfterMs * (1 + Math.random() * 0.2)),
      };
    }
    return { closeCode: CONNECT_FAILED_CLOSE_CODE, closeReason: "connect failed" };
  }

  private handlePairingResolution(event: EventFrame): void {
    if (event.event !== "device.pair.resolved" || !this.pendingPairing) {
      return;
    }
    const payload = event.payload;
    if (
      !isRecord(payload) ||
      payload.requestId !== this.pendingPairing.requestId ||
      payload.deviceId !== this.pendingPairing.deviceId
    ) {
      return;
    }
    const decision = payload.decision;
    if (decision !== "approved" && decision !== "rejected" && decision !== "expired") {
      return;
    }
    if (decision === "rejected" || decision === "expired") {
      this.pairingFailure = new GatewayRequestError({
        code: "NOT_PAIRED",
        message:
          decision === "rejected"
            ? "This browser's access request was declined."
            : "This browser's access request expired.",
        details: {
          code:
            decision === "rejected"
              ? ConnectErrorDetailCodes.PAIRING_REJECTED
              : ConnectErrorDetailCodes.PAIRING_EXPIRED,
          ...this.pendingPairing,
          pauseReconnect: true,
        },
      });
    }
    this.client.closeSocket(CONNECT_FAILED_CLOSE_CODE, `pairing ${decision}`);
  }

  private selectConnectAuth(params: {
    role: string;
    deviceId: string;
  }): GatewayConnectAuthSelection {
    if (this.remoteIngress) {
      return {};
    }
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
    const requestOptions: GatewayProtocolRequestOptions = {
      ...options,
      onSent: (requestId) => {
        this.firstUnansweredRequestAtMs ??= Date.now();
        options?.onSent?.(requestId);
      },
    };
    return method === "talk.catalog"
      ? requestTalkCatalog<T>(
          (retryOptions) => this.chatEvents.request<T>(this.client, method, params, retryOptions),
          this.catalogRetryAbort.signal,
          requestOptions,
        )
      : this.chatEvents.request<T>(this.client, method, params, requestOptions);
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
}
