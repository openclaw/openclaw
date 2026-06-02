import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";

export type SharedGatewayAuthClient = {
  /** True for clients authenticated through shared Gateway credentials. */
  usesSharedGatewayAuth?: boolean;
  /** Auth generation observed when the client authenticated. */
  sharedGatewaySessionGeneration?: string;
  /** WebSocket-like close hook used to disconnect stale clients. */
  socket: { close: (code: number, reason: string) => void };
};

export type SharedGatewaySessionGenerationState = {
  /** Generation currently active in the runtime auth snapshot. */
  current: string | undefined;
  /** Generation new clients must match; null means "use current". */
  required: string | undefined | null;
};

/**
 * Disconnect shared-auth clients whose auth generation no longer matches
 * runtime state. Device-token and other non-shared auth clients are left alone
 * because their validity is tracked by different credential material.
 */
export function disconnectStaleSharedGatewayAuthClients(params: {
  /** Live Gateway clients to inspect. */
  clients: Iterable<SharedGatewayAuthClient>;
  /** Required generation for shared-auth clients; mismatches are closed. */
  expectedGeneration: string | undefined;
}): void {
  for (const gatewayClient of params.clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    if (gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration) {
      continue;
    }
    try {
      gatewayClient.socket.close(4001, "gateway auth changed");
    } catch {
      /* ignore */
    }
  }
}

/** Disconnect every client authenticated with shared Gateway credentials. */
export function disconnectAllSharedGatewayAuthClients(
  clients: Iterable<SharedGatewayAuthClient>,
): void {
  for (const gatewayClient of clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    try {
      gatewayClient.socket.close(4001, "gateway auth changed");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve the generation that new shared-auth clients must present. A null
 * staged requirement means the current runtime snapshot is authoritative.
 */
export function getRequiredSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
): string | undefined {
  return state.required === null ? state.current : state.required;
}

/**
 * Update current generation and clear obsolete staged requirements. This keeps
 * hot-reload snapshots from rejecting clients with a generation that just became
 * current.
 */
export function setCurrentSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
  nextGeneration: string | undefined,
): void {
  const previousGeneration = state.current;
  state.current = nextGeneration;
  if (state.required === nextGeneration) {
    state.required = null;
    return;
  }
  // A runtime snapshot generation change invalidates a staged requirement from
  // an older snapshot; leaving it set would reject freshly authenticated clients.
  if (state.required !== null && previousGeneration !== nextGeneration) {
    state.required = null;
  }
}

/**
 * Apply generation policy after config writes that may rotate Gateway shared
 * auth. Reload-disabled configs stage the new generation as required immediately;
 * hot-reload configs advance current generation and disconnect stale clients.
 */
export function enforceSharedGatewaySessionGenerationForConfigWrite(params: {
  /** Mutable runtime generation state shared by config writes and WS auth. */
  state: SharedGatewaySessionGenerationState;
  /** Config after the write, used to decide whether hot reload is disabled. */
  nextConfig: OpenClawConfig;
  /** Reads the runtime snapshot generation after the config write is prepared. */
  resolveRuntimeSnapshotGeneration: () => string | undefined;
  /** Live Gateway clients to disconnect when their shared auth generation is stale. */
  clients: Iterable<SharedGatewayAuthClient>;
}): void {
  const reloadMode = resolveGatewayReloadSettings(params.nextConfig).mode;
  const nextSharedGatewaySessionGeneration = params.resolveRuntimeSnapshotGeneration();
  if (reloadMode === "off") {
    params.state.current = nextSharedGatewaySessionGeneration;
    params.state.required = nextSharedGatewaySessionGeneration;
    disconnectStaleSharedGatewayAuthClients({
      clients: params.clients,
      expectedGeneration: nextSharedGatewaySessionGeneration,
    });
    return;
  }
  params.state.required = null;
  setCurrentSharedGatewaySessionGeneration(params.state, nextSharedGatewaySessionGeneration);
  disconnectStaleSharedGatewayAuthClients({
    clients: params.clients,
    expectedGeneration: nextSharedGatewaySessionGeneration,
  });
}
