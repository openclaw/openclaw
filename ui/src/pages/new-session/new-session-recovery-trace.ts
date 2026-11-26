import { createGatewayControlUiReloadOptions } from "../../app/gateway-control-ui-reload.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";

// Diagnostic branch only: retain gate decisions without recording connection credentials.
export function traceNewSessionReloadOptions(
  gateway: ApplicationGateway,
  host: HTMLElement,
  isActive: () => boolean,
) {
  const connection = gateway.connection;
  const client = gateway.snapshot.client;
  const options = createGatewayControlUiReloadOptions(
    gateway,
    () => isActive() && host.isConnected,
  );
  const canReload = options.canReload;
  options.canReload = () => {
    const allowed = canReload();
    console.info(
      "[new-session-recovery]",
      JSON.stringify({
        phase: "caller-gate",
        allowed,
        active: isActive(),
        connected: host.isConnected,
        capturedClient: Boolean(client),
        currentClient: Boolean(gateway.snapshot.client),
        sameClient: client === gateway.snapshot.client,
        sameConnection: connection === gateway.connection,
        gatewayPhase: gateway.snapshot.phase,
      }),
    );
    return allowed;
  };
  return options;
}
