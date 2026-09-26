import type { ApplicationContext } from "./context.ts";

/** Bind delayed session notices and their actions to the submitting Gateway owner. */
export function captureSessionNoticeOwner(
  context: Pick<ApplicationContext, "gateway">,
): () => boolean {
  const { gateway } = context;
  const client = gateway.snapshot.client;
  const revision = gateway.connectionRevision;
  const gatewayUrl = gateway.connection.gatewayUrl;
  const recoveryScope = gateway.snapshot.hello?.auth?.recoveryScope;
  const profileId = gateway.snapshot.selfUser?.id ?? null;
  return () =>
    context.gateway === gateway &&
    gateway.snapshot.phase === "connected" &&
    gateway.connection.gatewayUrl === gatewayUrl &&
    gateway.connectionRevision === revision &&
    gateway.snapshot.hello?.auth?.recoveryScope === recoveryScope &&
    (gateway.snapshot.selfUser?.id ?? null) === profileId &&
    // A transport reconnect preserves an authenticated owner. Unscoped actions
    // remain bound to the original connection.
    (Boolean(recoveryScope) || gateway.snapshot.client === client);
}
