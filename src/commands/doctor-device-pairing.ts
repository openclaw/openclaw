/** Doctor diagnostics for pending, paired, and locally cached device auth state. */
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../packages/terminal-core/src/note.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { loadDeviceAuthTokens } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import {
  summarizeDeviceTokens,
  type DeviceAuthTokenSummary,
} from "../infra/device-pairing-tokens.js";
import {
  listApprovedPairedDeviceRoles,
  listDevicePairingReadOnly,
  type DevicePairingPendingRequest,
  type PairedDevice,
} from "../infra/device-pairing.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

const DEVICE_PAIRING_CHECK_ID = "core/doctor/device-pairing";

type GatewayListedPairedDevice = Omit<PairedDevice, "tokens" | "approvedScopes"> & {
  tokens?: DeviceAuthTokenSummary[];
};

type GatewayDevicePairingPayload = {
  pending: DevicePairingPendingRequest[];
  paired: GatewayListedPairedDevice[];
};

type DoctorPairedDevice = Omit<PairedDevice, "tokens"> & {
  tokenSummaries: DeviceAuthTokenSummary[];
};

type DoctorPairingSnapshot = {
  pending: DevicePairingPendingRequest[];
  paired: DoctorPairedDevice[];
};

function normalizeGatewayPairedDevice(device: GatewayListedPairedDevice): DoctorPairedDevice {
  return {
    ...device,
    tokenSummaries: device.tokens ?? [],
  };
}

function normalizeLocalPairedDevice(device: PairedDevice): DoctorPairedDevice {
  return {
    ...device,
    tokenSummaries: summarizeDeviceTokens(device.tokens) ?? [],
  };
}

async function loadDoctorPairingSnapshot(params: {
  cfg: OpenClawConfig;
  healthOk: boolean;
}): Promise<DoctorPairingSnapshot | null> {
  if (params.healthOk) {
    try {
      const { bindAgentToolGatewayRequest } = await import("../agents/tools/in-process-gateway.js");
      const requestGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
      const payload = await requestGateway<GatewayDevicePairingPayload>({
        method: "device.pair.list",
        timeoutMs: 5_000,
        config: params.cfg,
      });
      return {
        pending: payload.pending,
        paired: payload.paired.map((device) => normalizeGatewayPairedDevice(device)),
      };
    } catch {
      // Gateway health already reported separately. Fall back to local pairing
      // state when doctor is running against a local gateway.
    }
  }
  if (params.cfg.gateway?.mode === "remote") {
    return null;
  }
  const local = await listDevicePairingReadOnly();
  return {
    pending: local.pending,
    paired: local.paired.map((device) => normalizeLocalPairedDevice(device)),
  };
}

function resolveApprovedScopes(
  device: Pick<DoctorPairedDevice, "approvedScopes" | "scopes">,
): string[] {
  return normalizeDeviceAuthScopes(device.approvedScopes ?? device.scopes);
}

function formatValues(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatCliArgs(args: string[]): string {
  return formatCliCommand(args.map(quoteCliArg).join(" "));
}

function describeDevice(params: {
  deviceId: string;
  displayName?: string;
  clientId?: string;
}): string {
  const label =
    sanitizeTerminalText(params.displayName?.trim() || "") ||
    sanitizeTerminalText(params.clientId?.trim() || "");
  return label ? `${label} (${params.deviceId})` : params.deviceId;
}

function findTokenSummary(
  device: DoctorPairedDevice,
  role: string,
): DeviceAuthTokenSummary | undefined {
  const normalizedRole = role.trim();
  return device.tokenSummaries.find((entry) => entry.role === normalizedRole && !entry.revokedAtMs);
}

function hasPendingScopeUpgrade(params: {
  requestedRoles: string[];
  pendingScopes: string[];
  approvedRoles: string[];
  approvedScopes: string[];
}): boolean {
  for (const role of params.requestedRoles) {
    if (!params.approvedRoles.includes(role)) {
      continue;
    }
    const requestedForRole = params.pendingScopes.filter((scope) =>
      role === "operator" ? scope.startsWith("operator.") : !scope.startsWith("operator."),
    );
    if (requestedForRole.length === 0) {
      continue;
    }
    if (
      !roleScopesAllow({
        role,
        requestedScopes: requestedForRole,
        allowedScopes: params.approvedScopes,
      })
    ) {
      return true;
    }
  }
  return false;
}

function collectPendingPairingFindings(snapshot: DoctorPairingSnapshot): HealthFinding[] {
  const pairedByDeviceId = new Map(snapshot.paired.map((device) => [device.deviceId, device]));
  return snapshot.pending.map((pending): HealthFinding => {
    const paired = pairedByDeviceId.get(pending.deviceId);
    const deviceLabel = describeDevice(pending);
    const approveCommand = formatCliArgs(["openclaw", "devices", "approve", pending.requestId]);
    const inspectCommand = formatCliArgs(["openclaw", "devices", "list"]);
    const fixHint = `Review with ${inspectCommand}, then approve with ${approveCommand}.`;
    const finding = {
      checkId: DEVICE_PAIRING_CHECK_ID,
      severity: "warning" as const,
      path: "devices.pending",
      target: `${pending.deviceId}:${pending.requestId}`,
      fixHint,
    };
    if (!paired) {
      return {
        ...finding,
        requirement: "first-time",
        message: `Pending device pairing request ${pending.requestId} for ${deviceLabel}. ${fixHint}`,
      };
    }
    if (paired.publicKey !== pending.publicKey) {
      const removeCommand = formatCliArgs(["openclaw", "devices", "remove", pending.deviceId]);
      const repairHint = `Remove the stale record with ${removeCommand}, then rerun ${inspectCommand} and approve with ${approveCommand}.`;
      return {
        ...finding,
        requirement: "public-key-repair",
        message: `Pending device repair ${pending.requestId} for ${deviceLabel}: the current device identity no longer matches the approved pairing record. This commonly loops on pairing-required for an already paired device. ${repairHint}`,
        fixHint: repairHint,
      };
    }
    const requestedRoles = normalizeUniqueSingleOrTrimmedStringList(
      [pending.roles, pending.role].flat(),
    );
    const approvedRoles = listApprovedPairedDeviceRoles(paired);
    if (requestedRoles.some((role) => !approvedRoles.includes(role))) {
      return {
        ...finding,
        requirement: "role-upgrade",
        message: `Pending role upgrade ${pending.requestId} for ${deviceLabel}: approved roles [${formatValues(approvedRoles)}], requested roles [${formatValues(requestedRoles)}]. ${fixHint}`,
      };
    }
    const approvedScopes = resolveApprovedScopes(paired);
    const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
    if (
      hasPendingScopeUpgrade({
        requestedRoles,
        pendingScopes: requestedScopes,
        approvedRoles,
        approvedScopes,
      })
    ) {
      return {
        ...finding,
        requirement: "scope-upgrade",
        message: `Pending scope upgrade ${pending.requestId} for ${deviceLabel}: approved scopes [${formatValues(approvedScopes)}], requested scopes [${formatValues(requestedScopes)}]. ${fixHint}`,
      };
    }
    return {
      ...finding,
      requirement: "repair",
      message: `Pending device repair ${pending.requestId} for ${deviceLabel}: the device is already paired, but a new approval is still required before the requested auth can be used. ${fixHint}`,
    };
  });
}

function collectPairedRecordFindings(snapshot: DoctorPairingSnapshot): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const device of snapshot.paired) {
    const deviceLabel = describeDevice(device);
    const finding = {
      checkId: DEVICE_PAIRING_CHECK_ID,
      severity: "warning" as const,
      path: "devices.paired",
      target: device.deviceId,
    };
    const approvedRoles = listApprovedPairedDeviceRoles(device);
    const approvedScopes = resolveApprovedScopes(device);
    if (approvedRoles.includes("operator") && approvedScopes.length === 0) {
      findings.push({
        ...finding,
        requirement: "missing-operator-scope-baseline",
        message: `Paired device ${deviceLabel} is missing its approved operator scope baseline. Scope upgrades can get stuck in pairing-required until the device repairs or is re-approved.`,
      });
    }
    for (const role of approvedRoles) {
      const token = findTokenSummary(device, role);
      const rotateCommand = formatCliArgs([
        "openclaw",
        "devices",
        "rotate",
        "--device",
        device.deviceId,
        "--role",
        role,
      ]);
      if (!token) {
        findings.push({
          ...finding,
          target: role ? `${device.deviceId}:${role}` : device.deviceId,
          requirement: "missing-active-role-token",
          message: `Paired device ${deviceLabel} has no active ${role} device token even though the role is approved. This commonly ends in pairing-required or device-token-mismatch. Rotate a fresh token with ${rotateCommand}.`,
          fixHint: `Rotate a fresh token with ${rotateCommand}.`,
        });
        continue;
      }
      if (
        token.scopes.length > 0 &&
        !roleScopesAllow({
          role,
          requestedScopes: token.scopes,
          allowedScopes: approvedScopes,
        })
      ) {
        const recoveryCommand = role === "node" ? `${rotateCommand} --no-scopes` : rotateCommand;
        findings.push({
          ...finding,
          target: role ? `${device.deviceId}:${role}` : device.deviceId,
          requirement: "token-outside-approved-scope",
          message: `Paired device ${deviceLabel} has a ${role} token outside the approved scope baseline [${formatValues(approvedScopes)}]. Rotate it with ${recoveryCommand}.`,
          fixHint: `Rotate it with ${recoveryCommand}.`,
        });
      }
    }
  }
  return findings;
}

function readLocalIdentity(env: NodeJS.ProcessEnv = process.env): { deviceId: string } | null {
  try {
    return loadDeviceIdentityIfPresent({ env });
  } catch {
    return null;
  }
}

async function readLocalDeviceAuthTokens(deviceId: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    return await loadDeviceAuthTokens({ deviceId, env });
  } catch {
    return [];
  }
}

async function collectLocalDeviceAuthFindings(
  snapshot: DoctorPairingSnapshot,
): Promise<HealthFinding[]> {
  const identity = readLocalIdentity();
  if (!identity) {
    return [];
  }
  const localTokens = await readLocalDeviceAuthTokens(identity.deviceId);
  const paired = snapshot.paired.find((device) => device.deviceId === identity.deviceId);
  if (!paired) {
    return [];
  }
  const deviceLabel = describeDevice(paired);
  const findings: HealthFinding[] = [];
  const approvedRoles = new Set(listApprovedPairedDeviceRoles(paired));
  for (const entry of localTokens) {
    const role = entry.role.trim();
    if (!role) {
      continue;
    }
    const finding = {
      checkId: DEVICE_PAIRING_CHECK_ID,
      severity: "warning" as const,
      path: "identity.device-auth",
      target: `${paired.deviceId}:${role}`,
    };
    const pairedToken = findTokenSummary(paired, role);
    if (!pairedToken) {
      if (approvedRoles.has(role)) {
        continue;
      }
      findings.push({
        ...finding,
        requirement: "local-role-no-longer-approved",
        message: `Local cached ${role} device auth for ${deviceLabel} no longer has a matching active gateway token, and that role is no longer approved for this device. Reconnect with shared gateway auth to refresh local auth, or remove the stale cached ${role} auth entry.`,
        fixHint: `Reconnect with shared gateway auth to refresh local auth, or remove the stale cached ${role} auth entry.`,
      });
      continue;
    }
    const rotateCommand = formatCliArgs([
      "openclaw",
      "devices",
      "rotate",
      "--device",
      paired.deviceId,
      "--role",
      role,
    ]);
    const gatewayIssuedAtMs = pairedToken.rotatedAtMs ?? pairedToken.createdAtMs;
    // Local device auth survives gateway restarts; compare timestamps to catch stale cached tokens.
    if (entry.updatedAtMs < gatewayIssuedAtMs) {
      findings.push({
        ...finding,
        requirement: "local-token-stale",
        message: `Local cached ${role} device token for ${deviceLabel} predates the gateway rotation. This is a stale device-token pattern and can fail with device token mismatch. Reconnect with shared gateway auth to refresh it, or rotate again with ${rotateCommand}.`,
        fixHint: `Reconnect with shared gateway auth to refresh it, or rotate again with ${rotateCommand}.`,
      });
      continue;
    }
    const cachedScopes = normalizeDeviceAuthScopes(entry.scopes);
    const pairedScopes = normalizeDeviceAuthScopes(pairedToken.scopes);
    if (cachedScopes.join("\n") !== pairedScopes.join("\n")) {
      findings.push({
        ...finding,
        requirement: "local-scopes-mismatch",
        message: `Local cached ${role} device scopes for ${deviceLabel} differ from the gateway record. Cached scopes [${formatValues(cachedScopes)}], gateway scopes [${formatValues(pairedScopes)}]. Reconnect with shared gateway auth to refresh it, or rotate with ${rotateCommand}.`,
        fixHint: `Reconnect with shared gateway auth to refresh it, or rotate with ${rotateCommand}.`,
      });
    }
  }
  return findings;
}

/** Warn about retired pairing stores that still need Doctor repair. */
async function collectLegacyPairingStoreFindings(cfg: OpenClawConfig): Promise<HealthFinding[]> {
  if (cfg.gateway?.mode === "remote") {
    return [];
  }
  const { listLegacyPairingStoreFiles } = await import("../infra/pairing-files.js");
  return (await listLegacyPairingStoreFiles()).map((filePath): HealthFinding => ({
    checkId: DEVICE_PAIRING_CHECK_ID,
    severity: "warning",
    message: `Legacy pairing store ${filePath} has not been imported into SQLite. Stop the Gateway and run openclaw doctor --fix. Unreadable sources remain in place for repair.`,
    path: "devices.legacy-store",
    requirement: "pairing-store-legacy-file",
    fixHint:
      "Stop the Gateway and run openclaw doctor --fix to import and archive the legacy pairing stores.",
  }));
}

export async function collectDevicePairingHealthFindings(params: {
  cfg: OpenClawConfig;
  healthOk?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<HealthFinding[]> {
  const legacyStoreFindings = await collectLegacyPairingStoreFindings(params.cfg);
  const { detectLegacyDeviceAuth } = await import("../infra/state-migrations.device-auth.js");
  // Retired device auth uses the source env; pairing/token reads keep lint's active state view.
  // Report this debt even without a reachable remote Gateway or local identity.
  const deviceAuth = detectLegacyDeviceAuth({ stateDir: resolveStateDir(params.env) });
  if (deviceAuth.sourcePresent) {
    const fixCommand = formatCliCommand("openclaw doctor --fix", params.env);
    const fixHint = `Stop the Gateway and run ${fixCommand} to finish migration or cleanup.`;
    legacyStoreFindings.push({
      checkId: DEVICE_PAIRING_CHECK_ID,
      severity: "warning",
      message: `Legacy device auth store ${sanitizeTerminalText(deviceAuth.sourcePath)} is still present, so doctor cannot inspect locally cached device tokens. ${fixHint}`,
      path: "identity.device-auth",
      requirement: "device-auth-store-legacy-file",
      fixHint,
    });
  }
  const snapshot = await loadDoctorPairingSnapshot({
    cfg: params.cfg,
    healthOk: params.healthOk ?? false,
  });
  if (!snapshot) {
    return legacyStoreFindings;
  }
  return [
    ...legacyStoreFindings,
    ...collectPendingPairingFindings(snapshot),
    ...collectPairedRecordFindings(snapshot),
    ...(await collectLocalDeviceAuthFindings(snapshot)),
  ];
}

/** Render the same local migration and pairing findings as structured Doctor output. */
export async function noteDevicePairingHealth(params: {
  cfg: OpenClawConfig;
  healthOk: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const findings = await collectDevicePairingHealthFindings(params);
  if (findings.length === 0) {
    return;
  }
  note(findings.map((finding) => `- ${finding.message}`).join("\n"), "Device pairing");
}
