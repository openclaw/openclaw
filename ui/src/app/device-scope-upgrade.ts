import { registerListener } from "../../../src/shared/listeners.js";
import {
  readScopeUpgradeAvailability,
  type ScopeUpgradeState,
} from "./device-scope-upgrade-availability.ts";
import type { ScopeUpgradeController } from "./device-scope-upgrade-controller.runtime.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";

type ScopeUpgradeControllerConstructor = new (
  initial: ApplicationGatewaySnapshot,
  onChange: () => void,
) => ScopeUpgradeController;

export type ScopeUpgradeCapability = ReturnType<typeof createScopeUpgradeCapability>;

/** App-lifetime state shared by every Inbox presenter and settings takeover. */
export function createScopeUpgradeCapability(gateway: ApplicationGateway) {
  const listeners = new Set<() => void>();
  let snapshot = gateway.snapshot;
  let controller: ScopeUpgradeController | null = null;
  let state = readScopeUpgradeAvailability(snapshot);

  const publish = (next: ScopeUpgradeState) => {
    if (JSON.stringify(state) === JSON.stringify(next)) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const syncController = () => {
    if (controller) {
      publish(controller.state);
    }
  };
  const syncGateway = (next: ApplicationGatewaySnapshot) => {
    snapshot = next;
    controller?.sync(snapshot);
    publish(controller?.state ?? readScopeUpgradeAvailability(snapshot));
  };
  const stopGateway = gateway.subscribe(syncGateway);

  return {
    get state() {
      return state;
    },
    activate(Controller: ScopeUpgradeControllerConstructor) {
      controller ??= new Controller(snapshot, syncController);
      controller.sync(snapshot);
      publish(controller.state);
    },
    request: (): void => controller?.request(),
    retry: (): void => controller?.retry(),
    cancel: (): void => controller?.cancel(),
    subscribe: (listener: () => void) => registerListener(listeners, listener),
    dispose() {
      stopGateway();
      controller?.dispose();
      controller = null;
      listeners.clear();
    },
  };
}
