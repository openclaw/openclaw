import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { prepareUserProfileSelectionAuthority } from "../state/user-channel-identity-operations.js";
import type { PairedDeviceTokenIdentity } from "./device-pairing-core.types.js";
import { executeDevicePairingMutation } from "./device-pairing-worker.js";

/** Bind selection and pairing publication to the same admitted physical store. */
export async function enrollDeviceProfile(
  input: { deviceId: string; profileId: string; expectedOperator: PairedDeviceTokenIdentity },
  options: {
    baseDir?: string;
    context?: OpenClawStateWorkerContext;
    assertCurrent: () => void;
    onTokensReplaced?: (deviceId: string, roles: readonly string[]) => void;
  },
) {
  const context =
    options.context ??
    captureOpenClawStateWorkerContext(
      options.baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: options.baseDir } } : {},
    );
  const captured = structuredClone(input);
  const profile = await prepareUserProfileSelectionAuthority(captured.profileId, {
    path: context.admission.databasePath,
    env: context.environment,
  });
  const assertCurrent = () => {
    options.assertCurrent();
    if (!profile || profile.profileId !== captured.profileId || !profile.isCurrent()) {
      throw new Error("Enrollment profile authority changed");
    }
  };
  assertCurrent();
  return executeDevicePairingMutation(
    { type: "devicePairing.enrollProfile", input: { ...captured, nowMs: Date.now() } },
    { context, assertCurrent, onTokensReplaced: options.onTokensReplaced },
  );
}
