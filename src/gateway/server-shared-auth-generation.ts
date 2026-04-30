import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayReloadSettings } from "./config-reload.js";

export type RevocationLogger = { warn: (message: string) => void };

export type SharedGatewayAuthClient = {
  connId?: string;
  usesSharedGatewayAuth?: boolean;
  sharedGatewaySessionGeneration?: string;
  socket: {
    close: (code: number, reason: string) => void;
    terminate?: () => void;
  };
};

export type SharedGatewaySessionGenerationState = {
  current: string | undefined;
  required: string | undefined | null;
};

function describeRevocationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

function forceCloseSharedAuthClient(
  client: SharedGatewayAuthClient,
  logger: RevocationLogger | undefined,
): void {
  try {
    client.socket.close(4001, "gateway auth changed");
    return;
  } catch (error) {
    logger?.warn(
      `shared-gateway-auth revocation: socket.close failed for connId=${
        client.connId ?? "<unknown>"
      }: ${describeRevocationError(error)}; attempting terminate()`,
    );
  }
  try {
    client.socket.terminate?.();
  } catch {
    // terminate is a last resort; there is no further escalation path.
  }
}

export function disconnectStaleSharedGatewayAuthClients(params: {
  clients: Iterable<SharedGatewayAuthClient>;
  expectedGeneration: string | undefined;
  logger?: RevocationLogger;
}): void {
  for (const gatewayClient of params.clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    if (gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration) {
      continue;
    }
    forceCloseSharedAuthClient(gatewayClient, params.logger);
  }
}

export function disconnectAllSharedGatewayAuthClients(
  clients: Iterable<SharedGatewayAuthClient>,
  logger?: RevocationLogger,
): void {
  for (const gatewayClient of clients) {
    if (!gatewayClient.usesSharedGatewayAuth) {
      continue;
    }
    forceCloseSharedAuthClient(gatewayClient, logger);
  }
}

export function getRequiredSharedGatewaySessionGeneration(
  state: SharedGatewaySessionGenerationState,
): string | undefined {
  return state.required === null ? state.current : state.required;
}

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
  if (state.required !== null && previousGeneration !== nextGeneration) {
    state.required = null;
  }
}

export function enforceSharedGatewaySessionGenerationForConfigWrite(params: {
  state: SharedGatewaySessionGenerationState;
  nextConfig: OpenClawConfig;
  resolveRuntimeSnapshotGeneration: () => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
  logger?: RevocationLogger;
}): void {
  const reloadMode = resolveGatewayReloadSettings(params.nextConfig).mode;
  const nextSharedGatewaySessionGeneration = params.resolveRuntimeSnapshotGeneration();
  if (reloadMode === "off") {
    params.state.current = nextSharedGatewaySessionGeneration;
    params.state.required = nextSharedGatewaySessionGeneration;
    disconnectStaleSharedGatewayAuthClients({
      clients: params.clients,
      expectedGeneration: nextSharedGatewaySessionGeneration,
      logger: params.logger,
    });
    return;
  }
  params.state.required = null;
  setCurrentSharedGatewaySessionGeneration(params.state, nextSharedGatewaySessionGeneration);
  disconnectStaleSharedGatewayAuthClients({
    clients: params.clients,
    expectedGeneration: nextSharedGatewaySessionGeneration,
    logger: params.logger,
  });
}
