import { loadDeviceIdentityIfPresentAsync } from "../../infra/device-identity-async.js";
import { publicKeyRawBase64UrlFromPem } from "../../infra/device-identity.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";
import { ExpectedCliError } from "../failure-output.js";

/**
 * Read-only by design: the SSH-verified pairing probe calls this remotely and
 * must never mint a fresh identity on a host that has not run the node host.
 */
export async function runNodeIdentityShow(opts: { json?: boolean }) {
  const identity = await loadDeviceIdentityIfPresentAsync();
  if (!identity) {
    const message =
      "no node device identity found (start the node host once with `openclaw node run` or `openclaw node install`)";
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
  const payload = {
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
  };
  if (opts.json) {
    writeRuntimeJson(defaultRuntime, payload, 0);
    return;
  }
  defaultRuntime.log(`deviceId:  ${payload.deviceId}`);
  defaultRuntime.log(`publicKey: ${payload.publicKey}`);
}
