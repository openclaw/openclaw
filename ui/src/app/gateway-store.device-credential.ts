import { CONTROL_UI_OPERATOR_ROLE } from "../api/gateway.ts";
// "Forget this browser" stored device-credential reset, split out of
// gateway-store.ts to keep that module inside the TS LOC ratchet. Token-only
// and gateway-scoped: the browser device identity and other gateways' stored
// tokens survive.
import { retireStoredGoalOperations } from "../lib/chat/goal-operation-storage.ts";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  peekStoredDeviceIdentityId,
} from "../lib/nodes/index.ts";
import type { ApplicationGateway, ApplicationGatewayConnectOptions } from "./gateway.ts";
import { persistSessionToken } from "./settings.ts";

type DeviceCredentialHost = {
  /** connect() replaces the store's connection object, so reads must be live. */
  gatewayUrl: () => string;
  connect: (overrides: ApplicationGatewayConnectOptions) => void;
  isStopped: () => boolean;
};

export function createDeviceCredentialMethods(
  host: DeviceCredentialHost,
): Required<Pick<ApplicationGateway, "hasStoredDeviceToken" | "forgetDeviceToken">> {
  const storedOperatorDeviceToken = () => {
    const deviceId = peekStoredDeviceIdentityId();
    if (!deviceId) {
      return null;
    }
    const entry = loadDeviceAuthToken({
      deviceId,
      gatewayUrl: host.gatewayUrl(),
      role: CONTROL_UI_OPERATOR_ROLE,
    });
    return entry ? { deviceId } : null;
  };
  return {
    hasStoredDeviceToken: () => storedOperatorDeviceToken() !== null,
    forgetDeviceToken: () => {
      const stored = storedOperatorDeviceToken();
      if (!stored) {
        return false;
      }
      const gatewayUrl = host.gatewayUrl();
      // Token-only reset: keep the browser device identity so the gateway can
      // mint a fresh token for the same device on the next pairing/login.
      clearDeviceAuthToken({
        deviceId: stored.deviceId,
        gatewayUrl,
        role: CONTROL_UI_OPERATOR_ROLE,
      });
      // A token-auth hello persists this gateway's shared token per tab. The
      // credential-free reconnect below gets rejected, so nothing later
      // rewrites that entry — without this explicit clear a reload would
      // restore the old sign-in the operator just confirmed forgetting.
      persistSessionToken(gatewayUrl, "");
      retireStoredGoalOperations(gatewayUrl);
      // A stopped gateway stays on the login gate; the cleared credential
      // simply won't be offered on the next explicit connect.
      if (!host.isStopped()) {
        // Connection auth selects shared/bootstrap tokens ahead of stored
        // device auth, so this tab's session credentials must go too or the
        // reconnect silently resumes the old session instead of fresh auth.
        host.connect({ token: "", bootstrapToken: "", password: "" });
      }
      return true;
    },
  };
}
