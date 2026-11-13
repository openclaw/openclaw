import {
  loadDeviceIdentityIfPresentAsync,
  loadOrCreateDeviceIdentityAsync,
} from "../infra/device-identity-async.js";
import { prepareCliGatewayStateAccess } from "./gateway-rpc.runtime.js";

/** Personal CLI/TUI use is opt-in; unattended clients keep their default installation key. */
export async function loadInteractiveOperatorDeviceIdentity(create = false) {
  await prepareCliGatewayStateAccess();
  const options = { identityKey: "interactive-operator" };
  const identity = create
    ? await loadOrCreateDeviceIdentityAsync(options)
    : await loadDeviceIdentityIfPresentAsync(options);
  if (!identity) {
    throw new Error(
      "No interactive operator enrollment exists. Run openclaw devices enroll for this Gateway first.",
    );
  }
  return identity;
}
