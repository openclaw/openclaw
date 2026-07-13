// Gateway WebSocket paired-device connects enforce pinned metadata and approved access.
import { GATEWAY_CLIENT_MODES } from "../../../../packages/gateway-protocol/src/client-info.js";
import { getBoundDeviceBootstrapProfile } from "../../../infra/device-bootstrap.js";
import {
  getPairedDevice,
  listEffectivePairedDeviceRoles,
  updatePairedDeviceMetadata,
} from "../../../infra/device-pairing.js";
import {
  isPairingSetupBootstrapProfile,
  resolveBootstrapProfileScopesForRole,
} from "../../../shared/device-bootstrap-profile.js";
import type { DeviceBootstrapProfile } from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import {
  resolvePairedAccessScopes,
  resolvePinnedClientMetadata,
} from "./connect-device-metadata.js";
import { shouldAllowSilentLocalPairing } from "./handshake-auth-helpers.js";
import type {
  AuthenticatedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

type PairedDevice = NonNullable<Awaited<ReturnType<typeof getPairedDevice>>>;
type PairingReason = "metadata-upgrade" | "role-upgrade" | "scope-upgrade";

export async function authorizeExistingGatewayDevice(params: {
  context: GatewayConnectPhaseContext;
  state: AuthenticatedGatewayConnect;
  paired: PairedDevice;
  devicePublicKey: string;
  clientAccessMetadata: {
    displayName?: string;
    remoteIp?: string;
    lastSeenAtMs: number;
    lastSeenReason: string;
  };
  handoffBootstrapProfile: DeviceBootstrapProfile | null;
  requirePairing: (reason: PairingReason, paired: PairedDevice) => Promise<boolean>;
  logUpgradeAudit: (
    reason: "role-upgrade" | "scope-upgrade",
    currentRoles: string[] | undefined,
    currentScopes: string[] | undefined,
  ) => void;
}): Promise<{ ok: boolean; handoffBootstrapProfile: DeviceBootstrapProfile | null }> {
  const { context, state, paired, devicePublicKey, clientAccessMetadata, requirePairing } = params;
  const { connectParams, hasBrowserOriginHeader, reportedClientIp } = context;
  const { connId, logGateway } = context.handler;
  const {
    role,
    scopes,
    device,
    deviceAuthPayloadVersion,
    authMethod,
    bootstrapTokenCandidate,
    pairingLocality,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    isNativeAppUi,
  } = state;
  let { handoffBootstrapProfile } = params;
  const claimedPlatform = connectParams.client.platform;
  const pairedPlatform = paired.platform;
  const claimedDeviceFamily = connectParams.client.deviceFamily;
  const pairedDeviceFamily = paired.deviceFamily;
  const metadataPinning = resolvePinnedClientMetadata({
    clientId: connectParams.client.id,
    clientMode: connectParams.client.mode,
    claimedPlatform,
    claimedDeviceFamily,
    pairedPlatform,
    pairedDeviceFamily,
  });
  const { platformMismatch, deviceFamilyMismatch } = metadataPinning;
  if (platformMismatch || deviceFamilyMismatch) {
    const allowSilentMetadataUpgrade = shouldAllowSilentLocalPairing({
      locality: pairingLocality,
      hasBrowserOriginHeader,
      isControlUi,
      isWebchat,
      isNativeAppUi,
      reason: "metadata-upgrade",
    });
    if (!allowSilentMetadataUpgrade) {
      logGateway.warn(
        `security audit: device metadata upgrade requested reason=metadata-upgrade device=${device?.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} payload=${deviceAuthPayloadVersion ?? "unknown"} claimedPlatform=${claimedPlatform ?? "<none>"} pinnedPlatform=${pairedPlatform ?? "<none>"} claimedDeviceFamily=${claimedDeviceFamily ?? "<none>"} pinnedDeviceFamily=${pairedDeviceFamily ?? "<none>"} client=${connectParams.client.id} conn=${connId}`,
      );
    }
    if (!(await requirePairing("metadata-upgrade", paired))) {
      return { ok: false, handoffBootstrapProfile };
    }
  } else {
    if (metadataPinning.pinnedPlatform) {
      connectParams.client.platform = metadataPinning.pinnedPlatform;
    }
    if (metadataPinning.pinnedDeviceFamily) {
      connectParams.client.deviceFamily = metadataPinning.pinnedDeviceFamily;
    }
  }
  const pairedRoles = listEffectivePairedDeviceRoles(paired);
  const pairedScopes = resolvePairedAccessScopes(paired);
  const allowedRoles = new Set(pairedRoles);
  if (allowedRoles.size === 0 || !allowedRoles.has(role)) {
    params.logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
    if (!(await requirePairing("role-upgrade", paired))) {
      return { ok: false, handoffBootstrapProfile };
    }
  }

  if (scopes.length > 0) {
    const scopesAllowed =
      pairedScopes.length > 0 &&
      roleScopesAllow({ role, requestedScopes: scopes, allowedScopes: pairedScopes });
    if (!scopesAllowed) {
      params.logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
      if (!(await requirePairing("scope-upgrade", paired))) {
        return { ok: false, handoffBootstrapProfile };
      }
    }
  }

  const retryBootstrapHandoffProfile =
    authMethod === "bootstrap-token" &&
    bootstrapTokenCandidate &&
    role === "node" &&
    scopes.length === 0 &&
    !isControlUi &&
    !isBrowserOperatorUi &&
    !isWebchat &&
    connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE &&
    pairedRoles.includes("operator") &&
    device
      ? await getBoundDeviceBootstrapProfile({
          ["token"]: bootstrapTokenCandidate,
          deviceId: device.id,
          publicKey: devicePublicKey,
        })
      : null;
  if (retryBootstrapHandoffProfile) {
    const retryBootstrapOperatorScopes = resolveBootstrapProfileScopesForRole(
      "operator",
      retryBootstrapHandoffProfile.scopes,
    );
    if (
      isPairingSetupBootstrapProfile(retryBootstrapHandoffProfile) &&
      roleScopesAllow({
        role: "operator",
        requestedScopes: retryBootstrapOperatorScopes,
        allowedScopes: pairedScopes,
      })
    ) {
      // If the first QR bootstrap hello-ok failed to reach mobile, the
      // bootstrap token is restored while the paired device already has
      // node+operator grants. Preserve the same bounded handoff on retry.
      handoffBootstrapProfile = retryBootstrapHandoffProfile;
    }
  }

  // Metadata pinning is approval-bound. Reconnects can update access metadata
  // and same-family mobile OS version labels, but real platform/device-family
  // changes must stay on the approved pairing record.
  if (device) {
    await updatePairedDeviceMetadata(device.id, {
      ...clientAccessMetadata,
      ...(metadataPinning.refreshPairedPlatform
        ? { platform: metadataPinning.refreshPairedPlatform }
        : {}),
    });
  }
  return { ok: true, handoffBootstrapProfile };
}
