import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

const listeners = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayWorkMetricsListeners"),
  () => new Set<() => void>(),
  (value) => value.clear(),
);

export function onGatewayWorkMetricsChanged(listener: () => void): () => void {
  return registerListener(listeners, listener);
}

export function notifyGatewayWorkMetricsChanged(): void {
  notifyListeners(listeners, undefined);
}
