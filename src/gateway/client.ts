// OpenClaw Gateway client facade.
// Injects OpenClaw host dependencies into the shared gateway-client package.
import { GatewayClient as BaseGatewayClient } from "../../packages/gateway-client/src/index.js";
import type {
  GatewayClientConnectionMetadata,
  GatewayClientHostDeps,
  GatewayClientOptions as BaseGatewayClientOptions,
  GatewayClientRequestOptions,
} from "../../packages/gateway-client/src/index.js";
import {
  clearDeviceAuthToken,
  clearOriginDeviceToken,
  loadDeviceAuthToken,
  loadDeviceAuthTokenReadOnly,
  loadOriginDeviceToken,
  loadOriginDeviceTokenReadOnly,
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
import { logDebug, logError } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { type DeviceAuthEntry, normalizeDeviceAuthRole } from "../shared/device-auth.js";
import { resolveGatewayClientPlatformIdentity } from "../shared/gateway-client-platform.js";
import { VERSION } from "../version.js";

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
        loadDeviceAuthToken: (params) => {
          if (readOnly) {
            return suppressStoredDeviceAuth
              ? null
              : loadOriginDeviceTokenReadOnly({ ...params, gatewayScope: deviceAuthScope });
          }
          const load = loadOriginDeviceToken({
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

export class GatewayClient {
  #client: BaseGatewayClient;

  constructor(opts: GatewayClientOptions) {
    const { deviceAuthScope, preparedDeviceAuth, sharedStateMode, ...baseOptions } = opts;
    const runtimeIdentity = resolveGatewayClientPlatformIdentity(process.platform);
    // Password-only read-only clients cannot use stored tokens for auth, retry, or persistence.
    const suppressStoredDeviceAuth =
      Boolean(deviceAuthScope && (baseOptions.token?.trim() || baseOptions.password?.trim())) ||
      (!deviceAuthScope &&
        sharedStateMode === "read-only" &&
        Boolean(baseOptions.password?.trim()) &&
        !baseOptions.token?.trim() &&
        !baseOptions.bootstrapToken?.trim() &&
        !baseOptions.deviceToken?.trim() &&
        !baseOptions.approvalRuntimeToken?.trim() &&
        !baseOptions.agentRuntimeIdentityToken?.trim() &&
        !baseOptions.preferBootstrapToken);
    for (const value of Object.values(baseOptions.edgeAuthHeaders ?? {})) {
      registerSecretValueForRedaction(value);
    }
    this.#client = new BaseGatewayClient({
      ...baseOptions,
      clientVersion: baseOptions.clientVersion ?? VERSION,
      platform: baseOptions.platform ?? runtimeIdentity.platform,
      deviceFamily:
        baseOptions.deviceFamily ??
        (baseOptions.platform === undefined ? runtimeIdentity.deviceFamily : undefined),
      hostDeps: createOpenClawGatewayClientHostDeps(
        baseOptions.hostDeps,
        deviceAuthScope,
        suppressStoredDeviceAuth,
        sharedStateMode,
        preparedDeviceAuth,
      ),
    });
  }

  start(): void {
    this.#client.start();
  }

  stop(): void {
    this.#client.stop();
  }

  stopAndWait(opts?: { timeoutMs?: number }): Promise<void> {
    return this.#client.stopAndWait(opts);
  }

  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    return this.#client.request<T>(method, params, opts);
  }

  /** Current transport state, including CLOSING before the close callback fires.
   * This is not authentication or readiness evidence on its own. */
  get connected(): boolean {
    return this.#client.connected;
  }

  getConnectionMetadata(): GatewayClientConnectionMetadata {
    return this.#client.getConnectionMetadata();
  }

  updateNodeManifest(manifest: {
    caps: string[];
    commands: string[];
    computerUse?: BaseGatewayClientOptions["computerUse"];
  }): void {
    this.#client.updateNodeManifest(manifest);
  }
}
