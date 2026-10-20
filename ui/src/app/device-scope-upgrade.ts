import { createChangeListeners } from "../../../src/shared/listeners.js";
import {
  readScopeUpgradeAvailability,
  type ScopeUpgradeState,
} from "./device-scope-upgrade-availability.ts";
import type { ScopeUpgradeOwner } from "./device-scope-upgrade-owner.runtime.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";

type ScopeUpgradeOwnerConstructor = new (
  initial: ApplicationGatewaySnapshot,
  onChange: () => void,
) => ScopeUpgradeOwner;

export type ScopeUpgradeCapability = ReturnType<typeof createScopeUpgradeCapability>;

/** App-lifetime state shared by every Inbox presenter and settings takeover. */
export function createScopeUpgradeCapability(gateway: ApplicationGateway) {
  const listeners = createChangeListeners();
  let snapshot = gateway.snapshot;
  let owner: ScopeUpgradeOwner | null = null;
  let state = readScopeUpgradeAvailability(snapshot);

  const publish = (next: ScopeUpgradeState) => {
    if (JSON.stringify(state) === JSON.stringify(next)) {
      return;
    }
    state = next;
    listeners.publish();
  };
  const syncOwner = () => {
    if (owner) {
      publish(owner.state);
    }
  };
  const syncGateway = (next: ApplicationGatewaySnapshot) => {
    snapshot = next;
    owner?.sync(snapshot);
    publish(owner?.state ?? readScopeUpgradeAvailability(snapshot));
  };
  // Refresh upgrade authority even while the lazy prompt is not mounted.
  const stopGateway = gateway.subscribe(syncGateway);

  return {
    get state() {
      return state;
    },
    activate(Owner: ScopeUpgradeOwnerConstructor) {
      owner ??= new Owner(snapshot, syncOwner);
      owner.sync(snapshot);
      publish(owner.state);
    },
    request: (): void => owner?.request(),
    retry: (): void => owner?.retry(),
    cancel: (): void => owner?.cancel(),
    subscribe: listeners.subscribe,
    dispose() {
      stopGateway();
      owner?.dispose();
      owner = null;
      listeners.clear();
    },
  };
}
