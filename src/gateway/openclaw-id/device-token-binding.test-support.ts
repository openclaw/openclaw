import { afterEach, beforeEach } from "vitest";
import { setDeviceTokenBindingOwner } from "./device-token-binding.js";

/** Match the service's binding publication for a tunnel with no enrolled devices. */
export function useEmptyDeviceTokenBindings() {
  beforeEach(() => {
    setDeviceTokenBindingOwner({
      lookup: () => undefined,
      devicesForPeer: () => [],
      isOperatorBindingCurrent: () => false,
      record: async () => {},
      forget: async () => {},
      reportMismatch() {},
    });
  });
  afterEach(() => setDeviceTokenBindingOwner(undefined));
}
