// Mobile bootstrap predicates keep native setup authorization out of the WS handler.
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../../../infra/device-pairing.js";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  resolveBootstrapProfileScopesForRole,
  type DeviceBootstrapProfile,
} from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { normalizeDeviceMetadataForAuth } from "../../device-auth.js";

export function isControlUiOperatorBootstrapProfile(params: {
  profile: DeviceBootstrapProfile | null;
  requestedScopes: readonly string[];
}): params is { profile: DeviceBootstrapProfile; requestedScopes: readonly string[] } {
  const { profile, requestedScopes } = params;
  if (!profile || profile.purpose !== "control-ui") {
    return false;
  }
  if (profile.roles.length !== 1 || profile.roles[0] !== "operator") {
    return false;
  }
  if (
    !profile.scopes.every((scope) =>
      (BOOTSTRAP_HANDOFF_OPERATOR_SCOPES as readonly string[]).includes(scope),
    )
  ) {
    return false;
  }
  return roleScopesAllow({
    role: "operator",
    requestedScopes,
    allowedScopes: profile.scopes,
  });
}

export function resolvePairedAccessScopes(
  device: Pick<PairedDevice, "approvedScopes" | "scopes"> | null | undefined,
): string[] {
  const scopes = Array.isArray(device?.approvedScopes)
    ? device.approvedScopes
    : Array.isArray(device?.scopes)
      ? device.scopes
      : [];
  return normalizeSortedUniqueTrimmedStringList(scopes);
}

export function isSetupCodeMobileBootstrapClient(client: {
  id?: string;
  platform?: string;
  deviceFamily?: string;
}): boolean {
  const platform = normalizeDeviceMetadataForAuth(client.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(client.deviceFamily);
  if (client.id === GATEWAY_CLIENT_IDS.ANDROID_APP) {
    return /^android(?:\s|$)/u.test(platform) && deviceFamily === "android";
  }
  if (client.id === GATEWAY_CLIENT_IDS.IOS_APP) {
    return /^(?:ios|ipados)(?:\s|$)/u.test(platform) && /^(?:iphone|ipad|ios)$/u.test(deviceFamily);
  }
  return false;
}

export function isMobileNodeBootstrapConnect(params: {
  role: string;
  scopes: readonly string[];
  isControlUi: boolean;
  isBrowserOperatorUi: boolean;
  isWebchat: boolean;
  clientMode?: string;
}): boolean {
  return (
    params.role === "node" &&
    params.scopes.length === 0 &&
    !params.isControlUi &&
    !params.isBrowserOperatorUi &&
    !params.isWebchat &&
    params.clientMode === GATEWAY_CLIENT_MODES.NODE
  );
}

function pairedDeviceAllowsBootstrapRole(params: {
  device: PairedDevice;
  profile: DeviceBootstrapProfile;
  role: string;
}): boolean {
  return (
    hasEffectivePairedDeviceRole(params.device, params.role) &&
    roleScopesAllow({
      role: params.role,
      requestedScopes: resolveBootstrapProfileScopesForRole(
        params.role,
        params.profile.scopes,
        params.profile.purpose,
      ),
      allowedScopes: resolvePairedAccessScopes(params.device),
    })
  );
}

export function pairedDeviceAllowsBootstrapProfile(params: {
  device: PairedDevice | null | undefined;
  devicePublicKey: string;
  profile: DeviceBootstrapProfile;
}): boolean {
  const device = params.device;
  return Boolean(
    device &&
    device.publicKey === params.devicePublicKey &&
    params.profile.roles.every((role) =>
      pairedDeviceAllowsBootstrapRole({ device, profile: params.profile, role }),
    ),
  );
}

export function pairedDeviceAllowsBootstrapOperator(params: {
  device: PairedDevice | null | undefined;
  devicePublicKey: string;
  profile: DeviceBootstrapProfile;
}): boolean {
  const device = params.device;
  return Boolean(
    device &&
    device.publicKey === params.devicePublicKey &&
    pairedDeviceAllowsBootstrapRole({ device, profile: params.profile, role: "operator" }),
  );
}
