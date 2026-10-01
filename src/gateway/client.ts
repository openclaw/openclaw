// OpenClaw Gateway client facade.
// Injects OpenClaw host dependencies into the shared gateway-client package.
import { parseHostForAddressChecks } from "../../packages/gateway-client/src/client-address-utils.js";
import { GatewayClient as BaseGatewayClient } from "../../packages/gateway-client/src/index.js";
import type {
  GatewayClientConnectionMetadata,
  GatewayClientHostDeps,
  GatewayClientOptions as BaseGatewayClientOptions,
  GatewayClientRequestOptions,
} from "../../packages/gateway-client/src/index.js";
import { markGatewayConnectAssemblyError } from "../../packages/gateway-client/src/request-error.js";
import { resolveGatewayWebSocketTransport } from "../../packages/gateway-client/src/websocket-transport.js";
import {
  clearDeviceAuthToken,
  clearOriginDeviceToken,
  loadDeviceAuthToken,
  loadDeviceAuthTokenReadOnly,
  loadOriginDeviceToken,
  loadOriginDeviceTokenReadOnly,
  prepareDeviceAuthStore,
  storeDeviceAuthToken,
  storeOriginDeviceToken,
} from "../infra/device-auth-store.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import {
  ensureInheritedManagedProxyRoutingActive,
  registerManagedProxyGatewayLoopbackBypass,
} from "../infra/net/proxy/proxy-lifecycle.js";
import type { SshTunnel } from "../infra/ssh-tunnel.js";
import { logDebug, logError } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { type DeviceAuthEntry, normalizeDeviceAuthRole } from "../shared/device-auth.js";
import { resolveGatewayClientPlatformIdentity } from "../shared/gateway-client-platform.js";
import { VERSION } from "../version.js";
import type { GatewaySshRoute } from "./connection-details.js";

export {
  GatewayClientRequestError,
  isGatewayConnectAssemblyError,
  isGatewayProtocolResponseError,
} from "../../packages/gateway-client/src/index.js";
export type {
  GatewayClientCloseInfo,
  GatewayClientRequestOptions,
  GatewayReconnectPausedInfo,
} from "../../packages/gateway-client/src/index.js";

export type GatewayClientOptions = BaseGatewayClientOptions & {
  /** Exact normalized remote gateway scope for origin-bound device credentials. */
  deviceAuthScope?: string;
  /** Prevent this client lifecycle from creating or mutating shared state. */
  sharedStateMode?: "read-only";
  /** Auth already resolved and validated by the one-shot call owner. */
  preparedDeviceAuth?: DeviceAuthEntry;
  /** Selected remote route; this client owns its SSH transport lifetime. */
  sshTunnel?: GatewaySshRoute;
  /** Transfer a tunnel already opened for the same selected route. */
  preparedSshTunnel?: SshTunnel;
};

function createOpenClawGatewayClientHostDeps(
  overrides?: GatewayClientHostDeps,
  deviceAuthScope?: string,
  suppressStoredDeviceAuth = false,
  sharedStateMode?: "read-only",
  preparedDeviceAuth?: DeviceAuthEntry,
): GatewayClientHostDeps {
  const readOnly = sharedStateMode === "read-only";
  // Prepared auth is immutable request input. Any later durable mutation must
  // still match this token so a stale request cannot undo a concurrent rotation.
  const rotationFence = preparedDeviceAuth
    ? { expectedToken: preparedDeviceAuth.token }
    : undefined;
  let tokenObservation:
    | { deviceId: string; role: string; expectedToken: string | null }
    | undefined;
  const observe = (params: { deviceId: string; role: string }) => {
    const deviceId = params.deviceId;
    const role = normalizeDeviceAuthRole(params.role);
    return (snapshot: { expectedToken: string | null }) => {
      tokenObservation = { deviceId, role, expectedToken: snapshot.expectedToken };
    };
  };
  const observedFor = (params: { deviceId: string; role: string }) =>
    tokenObservation?.deviceId === params.deviceId &&
    tokenObservation.role === normalizeDeviceAuthRole(params.role)
      ? tokenObservation
      : undefined;
  const writeFence = (params: { deviceId: string; role: string }) => {
    if (rotationFence) {
      return rotationFence;
    }
    // Each connection's accepted writes settle before its successor loads another observation.
    const observed = observedFor(params);
    return observed ? { expectedToken: observed.expectedToken } : undefined;
  };
  const clearFence = (params: { deviceId: string; role: string; expectedToken?: string }) => {
    const expectedToken = rotationFence?.expectedToken ?? params.expectedToken;
    const raw = observedFor(params)?.expectedToken;
    return {
      ...rotationFence,
      ...(typeof raw === "string" && raw !== expectedToken && raw.trim() === expectedToken
        ? { observedToken: raw }
        : {}),
    };
  };
  const deviceAuthDeps: Pick<
    GatewayClientHostDeps,
    "loadDeviceAuthToken" | "storeDeviceAuthToken" | "clearDeviceAuthToken"
  > = deviceAuthScope
    ? {
        loadDeviceAuthToken: async (params) => {
          if (readOnly) {
            return suppressStoredDeviceAuth
              ? null
              : loadOriginDeviceTokenReadOnly({ ...params, gatewayScope: deviceAuthScope });
          }
          const load = await loadOriginDeviceToken({
            ...params,
            gatewayScope: deviceAuthScope,
            onSnapshot: observe(params),
          });
          return suppressStoredDeviceAuth ? null : load;
        },
        storeDeviceAuthToken: readOnly
          ? () => {}
          : (params) =>
              storeOriginDeviceToken({
                ...params,
                gatewayScope: deviceAuthScope,
                ...writeFence(params),
              }),
        clearDeviceAuthToken: readOnly
          ? () => {}
          : (params) =>
              clearOriginDeviceToken({
                ...params,
                gatewayScope: deviceAuthScope,
                ...clearFence(params),
              }),
      }
    : readOnly
      ? {
          loadDeviceAuthToken: suppressStoredDeviceAuth ? () => null : loadDeviceAuthTokenReadOnly,
          storeDeviceAuthToken: () => {},
          clearDeviceAuthToken: () => {},
        }
      : {
          loadDeviceAuthToken: (params) =>
            loadDeviceAuthToken({ ...params, onSnapshot: observe(params) }),
          storeDeviceAuthToken: (params) =>
            storeDeviceAuthToken({ ...params, ...writeFence(params) }),
          clearDeviceAuthToken: (params) =>
            clearDeviceAuthToken({ ...params, ...clearFence(params) }),
        };
  const preparedDeviceAuthDeps = preparedDeviceAuth
    ? { ...deviceAuthDeps, loadDeviceAuthToken: () => preparedDeviceAuth }
    : deviceAuthDeps;
  return {
    // This wrapper is the only place the package reaches into OpenClaw runtime
    // state. Keep device identity, token storage, proxy, and redaction here.
    loadOrCreateDeviceIdentity,
    signDevicePayload,
    publicKeyRawBase64UrlFromPem,
    ...preparedDeviceAuthDeps,
    beforeConnect: ensureInheritedManagedProxyRoutingActive,
    registerGatewayLoopbackBypass: registerManagedProxyGatewayLoopbackBypass,
    logDebug,
    logError,
    redactForLog: redactToolPayloadText,
    ...overrides,
    ...(readOnly
      ? {
          // Read-only is an authoritative lifecycle policy: caller overrides
          // must not restore identity creation or token writes behind it.
          loadOrCreateDeviceIdentity: () => loadDeviceIdentityIfPresent() ?? undefined,
          ...preparedDeviceAuthDeps,
        }
      : {}),
  };
}

function shouldSuppressStoredDeviceAuth(opts: GatewayClientOptions): boolean {
  // Password-only read-only clients cannot use stored tokens for auth, retry, or persistence.
  return (
    Boolean(opts.deviceAuthScope && (opts.token?.trim() || opts.password?.trim())) ||
    (!opts.deviceAuthScope &&
      opts.sharedStateMode === "read-only" &&
      Boolean(opts.password?.trim()) &&
      !opts.token?.trim() &&
      !opts.bootstrapToken?.trim() &&
      !opts.deviceToken?.trim() &&
      !opts.approvalRuntimeToken?.trim() &&
      !opts.agentRuntimeIdentityToken?.trim() &&
      !opts.preferBootstrapToken)
  );
}

/** Prepare storage before the one-shot RPC budget; connection loads still observe current rows. */
export async function prepareGatewayClientDeviceAuth(
  opts: GatewayClientOptions & {
    url: string;
    deviceIdentity: NonNullable<GatewayClientOptions["deviceIdentity"]> | null;
  },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (
    opts.deviceIdentity === null ||
    opts.preparedDeviceAuth ||
    (opts.sharedStateMode === "read-only" && shouldSuppressStoredDeviceAuth(opts))
  ) {
    return;
  }
  // Leave transport rejection with the client, before it can open token storage.
  try {
    if (Object.keys(opts.edgeAuthHeaders ?? {}).length && new URL(opts.url).protocol !== "wss:") {
      return;
    }
    resolveGatewayWebSocketTransport({
      url: opts.url,
      tlsFingerprint: opts.tlsFingerprint,
      env: opts.env,
      options: {},
    });
  } catch {
    return;
  }
  try {
    await prepareDeviceAuthStore({
      env: opts.env,
      signal,
      readOnly: opts.sharedStateMode === "read-only",
    });
  } catch (error) {
    throw markGatewayConnectAssemblyError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export class GatewayClient {
  #client?: BaseGatewayClient;
  #options: GatewayClientOptions;
  #tunnel?: SshTunnel;
  #starting?: Promise<void>;
  #stopping?: Promise<void>;
  #lifetime = new AbortController();

  constructor(opts: GatewayClientOptions) {
    if (opts.sshTunnel && !opts.deviceAuthScope) {
      throw new Error("Gateway SSH route requires its own device-auth scope");
    }
    if (opts.preparedSshTunnel && !opts.sshTunnel) {
      throw new Error("Prepared Gateway SSH tunnel requires its selected route");
    }
    this.#options = opts;
    this.#tunnel = opts.preparedSshTunnel;
    if (!opts.sshTunnel) {
      this.#client = this.createClient(opts.url);
    }
  }

  private createClient(url: string | undefined, tlsServerName?: string): BaseGatewayClient {
    const opts = this.#options;
    const {
      deviceAuthScope,
      preparedDeviceAuth,
      sharedStateMode,
      sshTunnel,
      preparedSshTunnel: _preparedSshTunnel,
      ...baseOptions
    } = opts;
    const runtimeIdentity = resolveGatewayClientPlatformIdentity(process.platform);
    const suppressStoredAuth = shouldSuppressStoredDeviceAuth(opts);
    for (const value of Object.values(baseOptions.edgeAuthHeaders ?? {})) {
      registerSecretValueForRedaction(value);
    }
    const hostDeps = createOpenClawGatewayClientHostDeps(
      baseOptions.hostDeps,
      deviceAuthScope,
      suppressStoredAuth,
      sharedStateMode,
      preparedDeviceAuth,
    );
    if (sshTunnel) {
      const beforeConnect = hostDeps.beforeConnect;
      hostDeps.beforeConnect = () => {
        beforeConnect?.();
        if (this.#lifetime.signal.aborted || !this.#tunnel?.isActive()) {
          throw new Error("Gateway SSH tunnel is no longer active");
        }
      };
    }
    return new BaseGatewayClient({
      ...baseOptions,
      url,
      ...(tlsServerName ? { tlsServerName } : {}),
      clientVersion: baseOptions.clientVersion ?? VERSION,
      platform: baseOptions.platform ?? runtimeIdentity.platform,
      deviceFamily:
        baseOptions.deviceFamily ??
        (baseOptions.platform === undefined ? runtimeIdentity.deviceFamily : undefined),
      hostDeps,
    });
  }

  start(): void {
    if (!this.#options.sshTunnel) {
      this.#client?.start();
      return;
    }
    if (this.#starting || this.#lifetime.signal.aborted) {
      return;
    }
    this.#starting = this.startSsh().catch((error: unknown) => {
      if (this.#lifetime.signal.aborted) {
        return;
      }
      this.stop();
      const failure = error instanceof Error ? error : new Error(String(error));
      this.notifySshClosed(failure);
    });
  }

  private async startSsh(): Promise<void> {
    const route = this.#options.sshTunnel;
    if (!route) {
      return;
    }
    const url = new URL(this.#options.url ?? "");
    if (!this.#tunnel) {
      const { startSshPortForward } = await import("../infra/ssh-tunnel.js");
      this.#lifetime.signal.throwIfAborted();
      this.#tunnel = await startSshPortForward({
        ...route,
        localPortPreferred: Number(url.port) || (url.protocol === "wss:" ? 443 : 80),
        timeoutMs: this.#options.preauthHandshakeTimeoutMs ?? 10_000,
        signal: this.#lifetime.signal,
      });
    }
    if (this.#lifetime.signal.aborted) {
      await this.#tunnel.stop();
      return;
    }
    if (!this.#tunnel.isActive()) {
      throw new Error("Gateway SSH tunnel closed before connection");
    }
    // A released local port must never become a reconnect target for this route.
    void this.#tunnel.closed.then(() => {
      if (!this.#lifetime.signal.aborted) {
        this.stop();
        this.notifySshClosed();
      }
    });
    const tlsServerName =
      url.protocol === "wss:"
        ? parseHostForAddressChecks(url.hostname)?.unbracketedHost
        : undefined;
    url.hostname = "127.0.0.1";
    url.port = String(this.#tunnel.localPort);
    this.#client = this.createClient(url.href, tlsServerName);
    this.#client.start();
  }

  private notifySshClosed(error?: Error): void {
    if (error) {
      try {
        this.#options.onConnectError?.(error);
      } catch {
        logError("Gateway SSH connect-error callback failed");
      }
    }
    try {
      this.#options.onClose?.(1006, error?.message ?? "Gateway SSH tunnel closed");
    } catch {
      logError("Gateway SSH close callback failed");
    }
  }

  stop(): void {
    if (!this.#options.sshTunnel) {
      this.#client?.stop();
      return;
    }
    void this.stopAndWait().catch((error: unknown) => logError(String(error)));
  }

  stopAndWait(opts?: { timeoutMs?: number }): Promise<void> {
    if (!this.#options.sshTunnel) {
      return this.#client?.stopAndWait(opts) ?? Promise.resolve();
    }
    this.#lifetime.abort();
    this.#client?.stop();
    return (this.#stopping ??= (async () => {
      try {
        await this.#starting;
        await this.#client?.stopAndWait(opts);
      } finally {
        await this.#tunnel?.stop();
      }
    })());
  }

  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    return this.#client
      ? this.#client.request<T>(method, params, opts)
      : Promise.reject(new Error("Gateway SSH connection has not started"));
  }

  /** Current transport state, including CLOSING before the close callback fires.
   * This is not authentication or readiness evidence on its own. */
  get connected(): boolean {
    return this.#client?.connected ?? false;
  }

  getConnectionMetadata(): GatewayClientConnectionMetadata {
    return (
      this.#client?.getConnectionMetadata() ?? {
        clientName: this.#options.clientName,
        hasDeviceIdentity: Boolean(this.#options.deviceIdentity),
        mode: this.#options.mode,
        preauthHandshakeTimeoutMs: this.#options.preauthHandshakeTimeoutMs,
      }
    );
  }

  updateNodeManifest(manifest: {
    caps: string[];
    commands: string[];
    computerUse?: BaseGatewayClientOptions["computerUse"];
  }): void {
    if (this.#client) {
      this.#client.updateNodeManifest(manifest);
    } else {
      this.#options = { ...this.#options, ...manifest };
    }
  }
}
