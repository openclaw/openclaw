import { clearDeviceAuthToken, loadDeviceAuthTokenReadOnly } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import { defaultRuntime } from "../runtime.js";
import { isImplicitLocalGatewayTargetFromCli } from "./gateway-rpc.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";

/** Capture only this installation's observed local operator credential before removal. */
export async function captureLocalOperatorTokenRemoval(
  opts: GatewayRpcOpts,
  deviceId: string,
): Promise<(() => Promise<void>) | undefined> {
  try {
    if (!(await isImplicitLocalGatewayTargetFromCli(opts))) {
      return undefined;
    }
    const env = { ...process.env };
    const identity = await loadDeviceIdentityIfPresentAsync({ env });
    if (identity?.deviceId !== deviceId) {
      return undefined;
    }
    const lookup = { env, deviceId, role: "operator" };
    const observed = await loadDeviceAuthTokenReadOnly(lookup);
    if (!observed) {
      return undefined;
    }
    return async () => {
      try {
        await clearDeviceAuthToken({ ...lookup, expectedToken: observed.token });
      } catch {
        defaultRuntime.error(
          "Gateway pairing was removed, but the local CLI credential could not be cleared. Check local credential-store access before pairing this client again.",
        );
      }
    };
  } catch {
    defaultRuntime.error(
      "Could not inspect local CLI credentials; continuing with Gateway removal. Check local credential-store access before pairing this client again.",
    );
    return undefined;
  }
}
