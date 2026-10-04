// Shared bootstrap/pairing helpers for plugins that provision remote devices.
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";

export { resolveDevicePairingApprovalDenial } from "../gateway/server-methods/device-management-authz.js";
export { approveDevicePairing } from "../infra/device-pairing-approval.js";
export { listDevicePairing } from "../infra/device-pairing.js";
export {
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
export {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
  type DeviceBootstrapPurpose,
} from "../shared/device-bootstrap-profile.js";

export const resolvePairingGatewayUrl = createLazyRuntimeMethod(
  () => import("../pairing/setup-code.js"),
  (pairing) => pairing.resolvePairingGatewayUrl,
);
