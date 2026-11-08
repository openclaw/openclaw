import { createChangeListeners } from "../../../src/shared/listeners.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { fetchWithControlUiAuth } from "../app/control-ui-auth.ts";
import { isConfiguredUiDevGateway } from "../dev-gateway.ts";

// Gateway startup owns connection context; avatar presentation stays in lazy views.
let appGatewayOrigin: string | null = null;
let appGatewayResourceBasePath = "";
let appGatewayAuthTokens: readonly string[] = [];
let appGatewayImageAuthTokens: readonly string[] = [];
let appGatewayStorageScope: string | undefined;
let gatewayRequests = new AbortController();
const unmanagedContextIsCurrent = () => true;
let isGatewayCurrent = unmanagedContextIsCurrent;
// More than one cache is keyed by the Gateway HTTP context (avatars,
// geolocation), so every subscriber must be notified on a switch. A single slot
// would silently drop whichever registered first.
const gatewayContextResets = createChangeListeners();

export const registerAvatarGatewayReset = gatewayContextResets.subscribe;

export function readAvatarGatewayContext() {
  return {
    origin: appGatewayOrigin,
    resourceBasePath: appGatewayResourceBasePath,
    authTokens: appGatewayImageAuthTokens,
    storageScope: appGatewayStorageScope,
  };
}

/** Recover rejected credentials only within the current Gateway and one request deadline. */
export async function fetchGatewayContextResource(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  auth: "gateway" | "image" = "gateway",
): Promise<Response> {
  const origin = appGatewayOrigin ?? globalThis.location?.origin ?? "http://localhost";
  if (new URL(url, origin).origin !== origin) {
    throw new Error("Resource must belong to the connected Gateway");
  }
  const requestSignal = AbortSignal.any([
    gatewayRequests.signal,
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  const isCurrent = isGatewayCurrent;
  const response = await fetchWithControlUiAuth(
    url,
    { credentials: "include", signal: requestSignal },
    auth === "image" ? appGatewayImageAuthTokens : appGatewayAuthTokens,
    isCurrent,
  );
  if (!isCurrent()) {
    void response.body?.cancel().catch(() => undefined);
    throw new DOMException("Gateway request is no longer current", "AbortError");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new Error("Gateway credentials rejected");
  }
  if (!response.ok) {
    // Optional resource callers ignore error bodies. Release the stream without
    // letting stalled cleanup delay their fallback or retryable result.
    void response.body?.cancel().catch(() => undefined);
  }
  return response;
}

function toHttpOrigin(url: string | null | undefined): string | null {
  const parsed = url ? URL.parse(url) : null;
  if (!parsed) {
    return null;
  }
  const scheme =
    parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
  return `${scheme}//${parsed.host}`;
}

/** Keeps avatar routes, credentials, and cached images scoped to the current gateway. */
export function setAvatarGatewayOrigin(
  gatewayUrl: string | null | undefined,
  authTokens: readonly string[] = [],
  resourceBasePath = "",
  storageScope?: string,
  isCurrent: () => boolean = unmanagedContextIsCurrent,
  imageAuthTokens: readonly string[] = authTokens,
): void {
  const nextOrigin =
    gatewayUrl && isConfiguredUiDevGateway(gatewayUrl)
      ? (globalThis.location?.origin ?? null)
      : toHttpOrigin(gatewayUrl);
  const documentOrigin = globalThis.location?.origin;
  const nextResourceBasePath =
    nextOrigin && documentOrigin === nextOrigin ? normalizeBasePath(resourceBasePath) : "";
  const contextChanged =
    isGatewayCurrent !== isCurrent ||
    appGatewayOrigin !== nextOrigin ||
    appGatewayResourceBasePath !== nextResourceBasePath ||
    // Initial admission adopts pending reads; replacement or retirement invalidates them.
    (appGatewayStorageScope !== undefined && appGatewayStorageScope !== storageScope) ||
    appGatewayImageAuthTokens.length !== imageAuthTokens.length ||
    appGatewayImageAuthTokens.some((token, index) => token !== imageAuthTokens[index]) ||
    appGatewayAuthTokens.length !== authTokens.length ||
    appGatewayAuthTokens.some((token, index) => token !== authTokens[index]);
  if (contextChanged) {
    // A replaced credential context must not finish an old fetch or advance
    // its rejected credential to another saved secret.
    gatewayRequests.abort();
    gatewayRequests = new AbortController();
    gatewayContextResets.publish();
  }
  appGatewayOrigin = nextOrigin;
  appGatewayResourceBasePath = nextResourceBasePath;
  appGatewayAuthTokens = [...authTokens];
  appGatewayImageAuthTokens = [...imageAuthTokens];
  appGatewayStorageScope = storageScope;
  isGatewayCurrent = isCurrent;
}
