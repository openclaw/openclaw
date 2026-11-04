import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { WorkspacePublicationHost } from "./workspace-publication-provider.js";

// Composition binds one existing host; the public Gateway context does not grant provider installation.
// Native SDK imports and the host loader must see the same exact-context binding.
const publicationHosts = resolveGlobalSingleton(
  Symbol.for("openclaw.workspacePublicationHosts"),
  () => new WeakMap<GatewayRequestContext, WorkspacePublicationHost>(),
);
// The current native wire names are retained while workspace transaction custody stays host-owned.
const workspacePublicationMethods = new Set([
  "sessions.github.readiness",
  "sessions.github.action",
  "sessions.github.publish",
  "sessions.github.options",
  "sessions.github.status",
  "sessions.github.confirm",
]);
export function isWorkspacePublicationGatewayMethod(method: string): boolean {
  return workspacePublicationMethods.has(method);
}
export function bindWorkspacePublicationHost(
  context: GatewayRequestContext,
  host: WorkspacePublicationHost,
): void {
  publicationHosts.set(context, host);
}
export function readWorkspacePublicationHost(
  context: GatewayRequestContext,
): WorkspacePublicationHost | undefined {
  const selected = context.resolveGatewayContext?.() ?? context;
  return publicationHosts.get(selected);
}

/** Retained tool calls stay bound to the exact installed publication owner. */
export function captureWorkspacePublicationProvider(
  context: GatewayRequestContext,
  pluginId: string,
): (() => void) | undefined {
  return readWorkspacePublicationHost(context)?.captureProviderAuthority(pluginId);
}
