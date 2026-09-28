import type { ApplicationContext } from "../../app/context.ts";

/** Bind delayed session notices and their actions to the submitting Gateway owner. */
export function captureSessionNoticeOwner(context: ApplicationContext): () => boolean {
  const { gateway } = context;
  const client = gateway.snapshot.client;
  const revision = gateway.connectionRevision;
  const gatewayUrl = gateway.connection.gatewayUrl;
  const recoveryScope = gateway.snapshot.hello?.auth?.recoveryScope;
  return () =>
    context.gateway === gateway &&
    gateway.snapshot.phase === "connected" &&
    gateway.connection.gatewayUrl === gatewayUrl &&
    gateway.connectionRevision === revision &&
    gateway.snapshot.hello?.auth?.recoveryScope === recoveryScope &&
    // A transport reconnect preserves an authenticated owner. Unscoped actions
    // remain bound to the original connection.
    (Boolean(recoveryScope) || gateway.snapshot.client === client);
}
