import type { ApplicationGateway } from "./gateway.ts";
import type { NativeGateway } from "./native-gateways.runtime.ts";

type NativeGatewaysWindow = Window & {
  __OPENCLAW_NATIVE_GATEWAY_HEALTH__?: { gatewayUrl: string; health: NativeGateway["health"] };
};

let healthReporter: object | undefined;

export function startNativeGatewayHealthReporting(gateway: ApplicationGateway): () => void {
  // SAFETY: The native document owns these optional globals; this reporter writes the typed health value.
  const nativeWindow = window as NativeGatewaysWindow;
  const owner = {};
  healthReporter = owner;
  const publish = (health: NativeGateway["health"]) => {
    if (healthReporter !== owner) {
      return;
    }
    const gatewayUrl = gateway.connection.gatewayUrl;
    const previous = nativeWindow["__OPENCLAW_NATIVE_GATEWAY_HEALTH__"];
    if (previous?.gatewayUrl === gatewayUrl && previous.health === health) {
      return;
    }
    nativeWindow["__OPENCLAW_NATIVE_GATEWAY_HEALTH__"] = { gatewayUrl, health };
    // The Mac embedder forwards this wake-up and reads the current document.
    // Linux shares the action bridge but does not implement health reporting.
    window.dispatchEvent(new Event("openclaw:native-gateway-health-changed"));
  };
  const refresh = () => {
    const { phase, lastError } = gateway.snapshot;
    publish(phase === "connected" ? "ok" : lastError ? "error" : "unknown");
  };
  const unsubscribe = gateway.subscribe(refresh);
  refresh();
  return () => {
    unsubscribe();
    if (healthReporter === owner) {
      publish("unknown");
      healthReporter = undefined;
    }
  };
}
