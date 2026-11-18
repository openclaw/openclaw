import {
  isBackgroundAssetId,
  USER_BACKGROUND_MAX_OUTPUT_BYTES,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { buildControlUiUserBackgroundPath } from "../../../src/gateway/control-ui-user-background-route.ts";
import type { ApplicationContext } from "../app/context.ts";
import { fetchWithControlUiAuth, resolveControlUiAuthCandidates } from "../app/control-ui-auth.ts";
import { gatewayWebSocketTransportUrl } from "../dev-gateway.ts";

function readScope(context: ApplicationContext, assetId: string) {
  const gateway = context.gateway;
  const snapshot = gateway.snapshot;
  const profileId = snapshot.selfUser?.id;
  if (
    !isBackgroundAssetId(assetId) ||
    snapshot.phase !== "connected" ||
    !snapshot.client ||
    !profileId
  ) {
    return null;
  }
  const auth = resolveControlUiAuthCandidates({
    hello: snapshot.hello,
    settings: gateway.connection,
    password: gateway.connection.password,
  });
  const transport = new URL(gatewayWebSocketTransportUrl(gateway.connection.gatewayUrl));
  transport.protocol = transport.protocol.replace(/^ws/u, "http");
  // A remote WebSocket pathname is not an HTTP resource mount.
  const basePath = transport.origin === location.origin ? context.resourceBasePath : "";
  const url = new URL(buildControlUiUserBackgroundPath(assetId, basePath), transport.origin).href;
  return {
    client: snapshot.client,
    auth,
    url,
    identity: JSON.stringify([
      gateway.connectionRevision,
      gateway.connection.gatewayUrl,
      profileId,
      url,
      auth,
    ]),
  };
}

/** Opaque in-memory comparison key; contains credentials and must never be persisted or logged. */
export function backgroundImageReadIdentity(
  context: ApplicationContext,
  assetId: string,
): string | null {
  return readScope(context, assetId)?.identity ?? null;
}

/** Shared by the pane renderer and Appearance thumbnail. Caller owns and revokes the returned Blob URL. */
export async function readBackgroundImage(
  context: ApplicationContext,
  assetId: string,
  options: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<string> {
  const scope = readScope(context, assetId);
  if (!scope) {
    throw new DOMException("Background image has no current profile", "AbortError");
  }
  const signal = AbortSignal.any([
    options.signal,
    ...(context.lifecycleAbortSignal ? [context.lifecycleAbortSignal] : []),
    AbortSignal.timeout(30_000),
  ]);
  const isCurrent = () => {
    const current = readScope(context, assetId);
    return (
      !signal.aborted &&
      options.isCurrent() &&
      current?.client === scope.client &&
      current.identity === scope.identity
    );
  };
  const checkCurrent = () => {
    signal.throwIfAborted();
    if (!isCurrent()) {
      throw new DOMException("Background image belongs to a retired profile", "AbortError");
    }
  };
  const response = await fetchWithControlUiAuth(
    scope.url,
    {
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
    },
    scope.auth,
    isCurrent,
  );
  checkCurrent();
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "image/jpeg"
  ) {
    void response.body?.cancel();
    throw new Error("Background image unavailable");
  }
  const blob = await response.blob();
  checkCurrent();
  if (!blob.size || blob.size > USER_BACKGROUND_MAX_OUTPUT_BYTES) {
    throw new Error("Background image exceeds its serving limit");
  }
  return URL.createObjectURL(blob);
}
