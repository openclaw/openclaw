// Device pairing runtime commands for gateway and loopback-local fallback operations.
import { coerceErrorMessage as normalizeErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { readConnectPairingRequiredMessage } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatGatewayTransportErrorJson } from "../gateway/call.js";
import type {
  DevicePairingList,
  DeviceTokenSummary,
  PairedDevice,
  PendingDevice,
} from "../gateway/device-pairing-list.types.js";
import { ADMIN_SCOPE, PAIRING_SCOPE, type OperatorScope } from "../gateway/method-scopes.js";
import { isOperatorScope } from "../gateway/operator-scopes.js";
import {
  approveDevicePairing,
  formatDevicePairingForbiddenMessage,
} from "../infra/device-pairing-approval.js";
import { summarizeDeviceTokens } from "../infra/device-pairing-tokens.js";
import {
  listDevicePairing,
  type PairedDevice as InfraPairedDevice,
} from "../infra/device-pairing.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../shared/device-pairing-access.js";
import { formatCliCommand } from "./command-format.js";
import {
  assertLocalFallbackMatchesGatewayRequest,
  buildFallbackStateMismatchError,
  resolveLocalPairingFallback,
} from "./devices-cli-fallback.js";
import { ExpectedCliError } from "./failure-output.js";
import { callGatewayFromCliWithTransport } from "./gateway-rpc.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { formatConnectionFlagReminder } from "./nodes-cli/cli-utils.js";
import { formatPairingApproveCommand } from "./pairing-command-format.js";

type DevicesRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  latest?: boolean;
  yes?: boolean;
  pending?: boolean;
  device?: string;
  role?: string;
  scope?: string[];
  scopes?: boolean;
  name?: string;
};

type ApprovePairingGatewayContext = {
  originalRequest: PendingDevice | null;
  pairingList: DevicePairingList | null;
  scopes?: OperatorScope[];
};

const FALLBACK_NOTICE = "Direct scope access failed; using local fallback.";
const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;
const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPE_PREFIX = "operator.";

const callGatewayCli = async (
  method: string,
  opts: DevicesRpcOpts,
  params?: unknown,
  callOpts?: { scopes?: OperatorScope[] },
) =>
  callGatewayFromCliWithTransport(method, opts, params, {
    label: `Devices ${method}`,
    defaultTimeoutMs: DEFAULT_DEVICES_TIMEOUT_MS,
    scopes: callOpts?.scopes,
    sharedStateMode: "read-only",
  });

function stringsMatch(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeOptionalString(left);
  const normalizedRight = normalizeOptionalString(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function pairedDeviceMatchesNodeApprovalQuery(device: PairedDevice, query: string): boolean {
  return (
    stringsMatch(device.deviceId, query) ||
    stringsMatch(device.remoteIp, query) ||
    stringsMatch(device.pendingNodeSurface?.requestId, query) ||
    stringsMatch(device.pendingNodeSurface?.remoteIp, query)
  );
}

function buildPendingNodeApprovalNotice(device: PairedDevice, opts: DevicesRpcOpts): string | null {
  const pending = device.pendingNodeSurface;
  const requestId = normalizeOptionalString(pending?.requestId);
  if (!pending || !requestId) {
    return null;
  }
  const action = device.nodeSurface ? "reapproval" : "approval";
  const label =
    normalizeOptionalString(device.operatorLabel) ??
    normalizeOptionalString(pending.displayName) ??
    normalizeOptionalString(device.nodeSurface?.displayName) ??
    normalizeOptionalString(device.displayName) ??
    device.deviceId;
  const command = formatPairingApproveCommand("nodes", requestId, { timeout: opts.timeout });
  const connectionReminder = formatConnectionFlagReminder(opts);
  const lines = [
    `Node ${action} pending for ${sanitizeForLog(label)}. Run ${sanitizeForLog(command)}`,
  ];
  if (connectionReminder) {
    lines.push(connectionReminder);
  }
  return lines.join("\n");
}

function findPairedDevicePendingNodeApprovalNotices(
  opts: DevicesRpcOpts,
  paired: PairedDevice[] | undefined,
): string[] {
  return (paired ?? []).flatMap((device) => {
    const notice = buildPendingNodeApprovalNotice(device, opts);
    return notice ? [notice] : [];
  });
}

function isDevicePairingApprovalDenied(error: unknown): boolean {
  return normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error)).includes(
    "device pairing approval denied",
  );
}

function isUnknownRequestIdError(error: unknown): boolean {
  const maybeGatewayError =
    typeof error === "object" && error !== null
      ? (error as { gatewayCode?: unknown; message?: unknown })
      : undefined;
  const gatewayCode = maybeGatewayError?.gatewayCode;
  if (gatewayCode !== undefined && gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message =
    typeof maybeGatewayError?.message === "string"
      ? maybeGatewayError.message
      : normalizeErrorMessage(error);
  return normalizeLowercaseStringOrEmpty(message).includes("unknown requestid");
}

function isScopeUpgradePendingApproval(error: unknown): boolean {
  return (
    readConnectPairingRequiredMessage(normalizeErrorMessage(error))?.reason === "scope-upgrade"
  );
}

function redactLocalPairedDevice(device: InfraPairedDevice): PairedDevice {
  const { tokens, ...rest } = device;
  return {
    ...rest,
    tokens: summarizeDeviceTokens(tokens),
  };
}

async function listPairingWithFallback(opts: DevicesRpcOpts): Promise<DevicePairingList> {
  try {
    return parseDevicePairingList(
      await callGatewayCli("device.pair.list", opts, {}, { scopes: [PAIRING_SCOPE] }),
    );
  } catch (error) {
    const fallback = resolveLocalPairingFallback(opts, error);
    if (!fallback) {
      throw error;
    }
    const local = await listDevicePairing();
    const list = {
      pending: local.pending as PendingDevice[],
      paired: local.paired.map((device) => redactLocalPairedDevice(device)),
    };
    assertLocalFallbackMatchesGatewayRequest(fallback.details, list);
    if (opts.json !== true) {
      defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
    }
    return list;
  }
}

async function approvePairingWithFallback(
  opts: DevicesRpcOpts,
  requestId: string,
  context: ApprovePairingGatewayContext,
): Promise<Record<string, unknown> | null> {
  const { scopes, originalRequest } = context;
  try {
    return await callGatewayCli(
      "device.pair.approve",
      opts,
      { requestId },
      scopes ? { scopes } : undefined,
    );
  } catch (error) {
    if (isDevicePairingApprovalDenied(error) && !scopes?.includes(ADMIN_SCOPE)) {
      try {
        return await callGatewayCli(
          "device.pair.approve",
          opts,
          { requestId },
          { scopes: [ADMIN_SCOPE] },
        );
      } catch (adminError) {
        if (isUnknownRequestIdError(adminError)) {
          return null;
        }
        throw adminError;
      }
    }
    const fallback = resolveLocalPairingFallback(opts, error);
    if (!fallback) {
      if (isUnknownRequestIdError(error)) {
        return null;
      }
      throw error;
    }
    return await runWithLocalStateOwner({
      method: "device.pair.approve",
      params: { requestId },
      target: requestId,
      onForeignOwner: "refuse",
      runLocal: async ({ env, assertCurrent }) => {
        const gatewayRequestId = normalizeOptionalString(fallback.details.requestId);
        let replacement: PendingDevice | null = null;
        if (gatewayRequestId && gatewayRequestId !== requestId) {
          const local = await listDevicePairing(env.OPENCLAW_STATE_DIR);
          const localList = {
            pending: local.pending as PendingDevice[],
            paired: local.paired.map((device) => redactLocalPairedDevice(device)),
          };
          context.pairingList = localList;
          replacement = findSameDeviceReplacementRequest({
            originalRequest,
            originalRequestId: requestId,
            gatewayRequestId,
            pending: localList.pending,
            paired: localList.paired,
          });
          if (!replacement) {
            const hasOriginalPending = Boolean(
              findPendingRequestById(localList.pending, requestId),
            );
            const hasGatewayPending = Boolean(
              findPendingRequestById(localList.pending, gatewayRequestId),
            );
            if (!hasOriginalPending && !hasGatewayPending) {
              return null;
            }
            // Fail-closed replacement validation refused to substitute; do not point
            // at the incompatible pending id as a recovery step.
            throw buildFallbackStateMismatchError(fallback.details, []);
          }
        }
        const approvedRequestId = replacement?.requestId ?? requestId;
        const approved = await approveDevicePairing(
          approvedRequestId,
          {
            // Local CLI fallback already assumes direct machine access; treat it as an
            // explicit admin approval path instead of relying on missing caller scopes.
            callerScopes: ["operator.admin"],
            isApprovalCurrent: () => {
              assertCurrent();
              return true;
            },
          },
          env.OPENCLAW_STATE_DIR,
        );
        if (!approved) {
          if (!replacement && gatewayRequestId && gatewayRequestId === requestId) {
            throw buildFallbackStateMismatchError(fallback.details, []);
          }
          return null;
        }
        if (approved.status === "forbidden") {
          throw new Error(formatDevicePairingForbiddenMessage(approved), { cause: error });
        }
        if (opts.json !== true) {
          if (replacement) {
            defaultRuntime.log(
              theme.warn(
                `Pending request ${sanitizeForLog(requestId)} was replaced by same-device repair ${sanitizeForLog(replacement.requestId)}; approving latest compatible request.`,
              ),
            );
          }
          defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
        }
        return {
          requestId: approvedRequestId,
          ...(replacement
            ? {
                resolved: {
                  kind: "same-device-replacement",
                  requestedRequestId: requestId,
                  approvedRequestId,
                },
              }
            : {}),
          device: redactLocalPairedDevice(approved.device),
        };
      },
    });
  }
}

function parseDevicePairingList(value: unknown): DevicePairingList {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    pending: Array.isArray(obj.pending) ? (obj.pending as PendingDevice[]) : [],
    paired: Array.isArray(obj.paired) ? (obj.paired as PairedDevice[]) : [],
  };
}

function normalizeDeviceRoles(request: PendingDevice): string[] {
  return normalizeUniqueTrimmedStringList([...(request.roles ?? []), request.role]);
}

function normalizeOperatorScopes(scopes: string[] | undefined): string[] {
  return normalizeDeviceAuthScopes(scopes).filter((scope) =>
    scope.startsWith(OPERATOR_SCOPE_PREFIX),
  );
}

function findPendingRequestById(
  pending: PendingDevice[] | undefined,
  requestId: string | null | undefined,
): PendingDevice | null {
  const normalizedRequestId = normalizeOptionalString(requestId);
  if (!normalizedRequestId) {
    return null;
  }
  return (
    pending?.find(
      (request) => normalizeOptionalString(request.requestId) === normalizedRequestId,
    ) ?? null
  );
}

function hasExactRoleMatch(original: PendingDevice, replacement: PendingDevice): boolean {
  const originalRoles = normalizeDeviceRoles(original);
  const replacementRoles = normalizeDeviceRoles(replacement);
  if (originalRoles.length !== replacementRoles.length) {
    return false;
  }
  const replacementRoleSet = new Set(replacementRoles);
  return originalRoles.every((role) => replacementRoleSet.has(role));
}

function hasCompatibleClientMetadata(original: PendingDevice, replacement: PendingDevice): boolean {
  return (["clientId", "clientMode"] as const).every((key) => {
    const before = normalizeOptionalString(original[key]);
    const after = normalizeOptionalString(replacement[key]);
    return !before || !after || before === after;
  });
}

function replacementScopesCoverOriginal(
  original: PendingDevice,
  replacement: PendingDevice,
  paired: PairedDevice | undefined,
): boolean {
  const originalScopes = uniqueStrings([
    ...normalizeDeviceAuthScopes(original.scopes),
    ...resolvePendingOperatorApprovalScopes(original, paired),
  ]);
  const replacementScopes = normalizeDeviceAuthScopes(replacement.scopes);
  const replacementScopeSet = new Set(replacementScopes);
  if (!originalScopes.every((scope) => replacementScopeSet.has(scope))) {
    return false;
  }
  // Same-device repair reconnects can supersede a stale request with a combined
  // request that appends the pairing scope required for the repaired session to
  // reconnect and complete approval.
  return replacementScopes.every(
    (scope) => originalScopes.includes(scope) || scope === PAIRING_SCOPE,
  );
}

function findSameDeviceReplacementRequest(params: {
  originalRequest: PendingDevice | null;
  originalRequestId: string;
  gatewayRequestId: string;
  pending: PendingDevice[] | undefined;
  paired: PairedDevice[] | undefined;
}): PendingDevice | null {
  const originalRequestId = normalizeOptionalString(params.originalRequestId);
  if (!params.originalRequest || !originalRequestId) {
    // Without the pre-approve snapshot we cannot prove that the gateway's newer
    // request is the same-device repair contract the operator intended to approve.
    return null;
  }
  if (normalizeOptionalString(params.originalRequest.requestId) !== originalRequestId) {
    return null;
  }
  const replacement = findPendingRequestById(params.pending, params.gatewayRequestId);
  if (!replacement) {
    return null;
  }
  if (
    !stringsMatch(params.originalRequest.deviceId, replacement.deviceId) ||
    !stringsMatch(params.originalRequest.publicKey, replacement.publicKey)
  ) {
    return null;
  }
  if (!hasExactRoleMatch(params.originalRequest, replacement)) {
    return null;
  }
  if (!hasCompatibleClientMetadata(params.originalRequest, replacement)) {
    return null;
  }
  const pairedByDeviceId = indexPairedDevices(params.paired);
  const originalPaired = lookupPairedDevice(pairedByDeviceId, params.originalRequest);
  const replacementPaired = lookupPairedDevice(pairedByDeviceId, replacement);
  if (!replacementScopesCoverOriginal(params.originalRequest, replacement, originalPaired)) {
    return null;
  }
  if (replacement.isRepair !== true && (!originalPaired || !replacementPaired)) {
    return null;
  }
  return replacement;
}

function resolvePairedOperatorScopes(paired: PairedDevice | undefined): string[] {
  const operatorToken = paired?.tokens?.find((token) => {
    const role = normalizeOptionalString(token.role);
    return role === OPERATOR_ROLE && !token.revokedAtMs;
  });
  return normalizeOperatorScopes(operatorToken?.scopes ?? paired?.scopes);
}

function resolvePendingOperatorApprovalScopes(
  request: PendingDevice,
  paired: PairedDevice | undefined,
): string[] {
  if (!normalizeDeviceRoles(request).includes(OPERATOR_ROLE)) {
    return [];
  }
  const requestedScopes = normalizeOperatorScopes(request.scopes);
  return requestedScopes.length > 0 ? requestedScopes : resolvePairedOperatorScopes(paired);
}

function resolvePairingCallScopes(operatorScopes: string[]): OperatorScope[] | undefined {
  if (operatorScopes.length === 0) {
    return undefined;
  }
  const out = new Set<OperatorScope>([PAIRING_SCOPE]);
  for (const scope of operatorScopes) {
    if (scope === ADMIN_SCOPE || !isOperatorScope(scope)) {
      return [ADMIN_SCOPE];
    }
    out.add(scope);
  }
  return [...out];
}

async function resolveTokenManagementScopes(
  opts: DevicesRpcOpts,
  target: { deviceId: string; role: string },
  requestedScopes?: string[],
): Promise<OperatorScope[] | undefined> {
  if (target.role !== OPERATOR_ROLE) {
    return [ADMIN_SCOPE];
  }
  const list = parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
  const paired = list.paired.find((device) => device.deviceId === target.deviceId);
  if (!paired) {
    // Pairing-scoped device-token lists expose only self; a hidden target needs
    // cross-device admin authority. The server still validates existence and access.
    return [ADMIN_SCOPE];
  }
  // Revoked tokens retain their scopes too. The approved device baseline is
  // only a ceiling, never a replacement for a narrowed token's scopes.
  const token = paired.tokens?.find((entry) => entry.role === target.role);
  return resolvePairingCallScopes(
    normalizeOperatorScopes(requestedScopes ?? token?.scopes ?? paired.scopes),
  );
}

async function resolveApprovePairingGatewayContext(
  opts: DevicesRpcOpts,
  requestId: string,
): Promise<ApprovePairingGatewayContext> {
  try {
    const list = await listPairingWithFallback(opts);
    const request = findPendingRequestById(list.pending, requestId);
    if (!request) {
      return { originalRequest: null, pairingList: list, scopes: undefined };
    }
    return {
      originalRequest: request,
      pairingList: list,
      scopes: resolvePairingCallScopes(
        resolvePendingOperatorApprovalScopes(
          request,
          lookupPairedDevice(indexPairedDevices(list.paired), request),
        ),
      ),
    };
  } catch {
    return { originalRequest: null, pairingList: null, scopes: undefined };
  }
}

function selectLatestPendingRequest(pending: PendingDevice[] | undefined) {
  if (!pending?.length) {
    return null;
  }
  return pending.reduce((latest, current) => {
    const latestTs = typeof latest.ts === "number" ? latest.ts : 0;
    const currentTs = typeof current.ts === "number" ? current.ts : 0;
    return currentTs > latestTs ? current : latest;
  });
}

function formatTokenSummary(tokens: DeviceTokenSummary[] | undefined) {
  if (!tokens || tokens.length === 0) {
    return "none";
  }
  const parts = tokens
    .map((t) => `${sanitizeForLog(t.role)}${t.revokedAtMs ? " (revoked)" : ""}`)
    .toSorted((a, b) => a.localeCompare(b));
  return parts.join(", ");
}

function formatPendingDeviceIdentity(request: PendingDevice): string {
  return sanitizeForLog(
    normalizeOptionalString(request.displayName) ?? normalizeOptionalString(request.deviceId) ?? "",
  );
}

function formatAccessSummary(access: DevicePairingAccessSummary | null): string {
  if (!access) {
    return "none";
  }
  const roles =
    access.roles.length > 0 ? access.roles.map((role) => sanitizeForLog(role)).join(", ") : "none";
  const scopes =
    access.scopes.length > 0
      ? access.scopes.map((scope) => sanitizeForLog(scope)).join(", ")
      : "none";
  return `roles: ${roles}; scopes: ${scopes}`;
}

const PENDING_APPROVAL_COPY: Record<PendingDeviceApprovalKind, { label: string; note: string }> = {
  "new-pairing": {
    label: "new pairing",
    note: "First-time device pairing request.",
  },
  "role-upgrade": {
    label: "role upgrade",
    note: "Already paired. Requested role exceeds the current approval, so reconnect stays blocked until you approve this upgrade.",
  },
  "scope-upgrade": {
    label: "scope upgrade",
    note: "Already paired. Requested scopes exceed the current approval, so reconnect stays blocked until you approve this upgrade.",
  },
  "re-approval": {
    label: "re-approval",
    note: "Already paired. Approval-bound device details changed, so OpenClaw created a fresh request instead of silently reusing the old approval.",
  },
};

function indexPairedDevices(paired: PairedDevice[] | undefined): Map<string, PairedDevice> {
  const out = new Map<string, PairedDevice>();
  for (const device of paired ?? []) {
    const deviceId = normalizeOptionalString(device.deviceId);
    if (deviceId) {
      out.set(deviceId, device);
    }
  }
  return out;
}

function lookupPairedDevice(
  pairedByDeviceId: ReadonlyMap<string, PairedDevice>,
  request: Pick<PendingDevice, "deviceId" | "publicKey">,
): PairedDevice | undefined {
  const normalizedDeviceId = normalizeOptionalString(request.deviceId);
  if (!normalizedDeviceId) {
    return undefined;
  }
  const paired = pairedByDeviceId.get(normalizedDeviceId);
  if (!paired) {
    return undefined;
  }
  const requestPublicKey = normalizeOptionalString(request.publicKey);
  const pairedPublicKey = normalizeOptionalString(paired.publicKey);
  if (requestPublicKey && pairedPublicKey && requestPublicKey !== pairedPublicKey) {
    return undefined;
  }
  return paired;
}

function formatAuthFlagReminder(opts: DevicesRpcOpts): string {
  const flags: string[] = [];
  if (normalizeOptionalString(opts.token)) {
    flags.push("--token");
  }
  if (normalizeOptionalString(opts.password)) {
    flags.push("--password");
  }
  if (flags.length === 0) {
    return "";
  }
  return `Reuse the same ${flags.join("/")} option${flags.length === 1 ? "" : "s"} when rerunning.`;
}

function failDevicesCommand(json: boolean | undefined, ...lines: string[]): void {
  // Throw JSON refusals to the root failure handler so stdout gets its one error document.
  if (json) {
    const message = lines.join("\n");
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
  for (const line of lines) {
    defaultRuntime.error(line);
  }
  defaultRuntime.exit(1);
}

function resolveRequiredDeviceRole(
  opts: DevicesRpcOpts,
): { deviceId: string; role: string } | null {
  const deviceId = normalizeStringifiedOptionalString(opts.device) ?? "";
  const role = normalizeStringifiedOptionalString(opts.role) ?? "";
  if (deviceId && role) {
    return { deviceId, role };
  }
  // Token commands always return JSON, including when --json is omitted.
  failDevicesCommand(
    true,
    `--device and --role are required. Run ${formatCliCommand("openclaw devices list")} to choose a paired device.`,
  );
  return null;
}

export async function runDevicesListCommand(opts: DevicesRpcOpts): Promise<void> {
  let list: DevicePairingList;
  try {
    list = await listPairingWithFallback(opts);
  } catch (error) {
    if (opts.json) {
      const payload = formatGatewayTransportErrorJson(error);
      if (payload) {
        defaultRuntime.writeJson(payload);
        defaultRuntime.exit(1);
        return;
      }
    }
    throw error;
  }
  const pairedByDeviceId = indexPairedDevices(list.paired);
  if (opts.json) {
    defaultRuntime.writeJson(list);
    return;
  }
  if (list.pending.length) {
    const tableWidth = getTerminalTableWidth();
    defaultRuntime.log(`${theme.heading("Pending")} ${theme.muted(`(${list.pending.length})`)}`);
    defaultRuntime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Request", header: "Request", minWidth: 10 },
          { key: "Device", header: "Device", minWidth: 16, flex: true },
          { key: "Requested", header: "Requested", minWidth: 20, flex: true },
          { key: "Approved", header: "Approved", minWidth: 20, flex: true },
          { key: "Age", header: "Age", minWidth: 8 },
          { key: "Status", header: "Status", minWidth: 12 },
        ],
        rows: list.pending.map((req) => {
          const approval = resolvePendingDeviceApprovalState(
            req,
            lookupPairedDevice(pairedByDeviceId, req),
          );
          const statusParts = [PENDING_APPROVAL_COPY[approval.kind].label];
          if (req.isRepair) {
            statusParts.push("repair");
          }
          return {
            Request: req.requestId,
            Device: `${formatPendingDeviceIdentity(req)}${req.remoteIp ? ` · ${sanitizeForLog(req.remoteIp)}` : ""}`,
            Requested: formatAccessSummary(approval.requested),
            Approved: formatAccessSummary(approval.approved),
            Age: typeof req.ts === "number" ? formatTimeAgo(Date.now() - req.ts) : "",
            Status: statusParts.join(", "),
          };
        }),
      }).trimEnd(),
    );
  }
  if (list.paired.length) {
    const tableWidth = getTerminalTableWidth();
    const rows = list.paired.map((device) => ({
      Device: sanitizeForLog(
        device.operatorLabel || device.displayName || device.clientId || device.deviceId,
      ),
      "Device ID": sanitizeForLog(device.deviceId),
      Roles: device.roles?.length
        ? device.roles.map((role) => sanitizeForLog(role)).join(", ")
        : "",
      Scopes: device.scopes?.length
        ? device.scopes.map((scope) => sanitizeForLog(scope)).join(", ")
        : "",
      Tokens: formatTokenSummary(device.tokens),
      IP: device.remoteIp ? sanitizeForLog(device.remoteIp) : "",
    }));
    defaultRuntime.log(`${theme.heading("Paired")} ${theme.muted(`(${list.paired.length})`)}`);
    defaultRuntime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Device", header: "Device", minWidth: 16, flex: true },
          { key: "Device ID", header: "Device ID", minWidth: 12, flex: true },
          { key: "Roles", header: "Roles", minWidth: 12, flex: true },
          { key: "Scopes", header: "Scopes", minWidth: 12, flex: true },
          { key: "Tokens", header: "Tokens", minWidth: 12, flex: true },
          { key: "IP", header: "IP", minWidth: 12 },
        ],
        rows,
      }).trimEnd(),
    );
    defaultRuntime.log(theme.muted("Full device IDs"));
    for (const row of rows) {
      defaultRuntime.log(`  ${row["Device ID"]}  ${row.Device}`);
    }
    const nodeApprovalNotices = findPairedDevicePendingNodeApprovalNotices(opts, list.paired);
    for (const notice of nodeApprovalNotices) {
      defaultRuntime.log(theme.warn(notice));
    }
  }
  if (!list.pending.length && !list.paired.length) {
    defaultRuntime.log(theme.muted("No device pairing entries."));
  }
}

export async function runDevicesDeleteCommand(
  operation: "remove" | "reject",
  id: string,
  opts: DevicesRpcOpts,
): Promise<void> {
  const trimmed = operation === "remove" ? id.trim() : normalizeOptionalString(id);
  const field = operation === "remove" ? "deviceId" : "requestId";
  if (!trimmed) {
    failDevicesCommand(
      opts.json,
      `${field} is required. Run ${formatCliCommand("openclaw devices list")} to choose a ${operation === "remove" ? "paired device" : "pending request"}.`,
    );
    return;
  }
  const result = await callGatewayCli(`device.pair.${operation}`, opts, { [field]: trimmed });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  const deviceId = operation === "remove" ? trimmed : (result as { deviceId?: string })?.deviceId;
  defaultRuntime.log(
    `${theme.warn(operation === "remove" ? "Removed" : "Rejected")} ${theme.command(deviceId ?? "ok")}`,
  );
}

export async function runDevicesClearCommand(opts: DevicesRpcOpts): Promise<void> {
  if (!opts.yes) {
    failDevicesCommand(opts.json, "Refusing to clear pairing table without --yes");
    return;
  }
  const list = parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
  const removedDeviceIds: string[] = [];
  const rejectedRequestIds: string[] = [];
  for (const device of list.paired) {
    const deviceId = normalizeOptionalString(device.deviceId) ?? "";
    if (!deviceId) {
      continue;
    }
    await callGatewayCli("device.pair.remove", opts, { deviceId });
    removedDeviceIds.push(deviceId);
  }
  if (opts.pending) {
    for (const req of list.pending) {
      const requestId = normalizeOptionalString(req.requestId) ?? "";
      if (!requestId) {
        continue;
      }
      await callGatewayCli("device.pair.reject", opts, { requestId });
      rejectedRequestIds.push(requestId);
    }
  }
  if (opts.json) {
    defaultRuntime.writeJson({
      removedDevices: removedDeviceIds,
      rejectedPending: rejectedRequestIds,
    });
    return;
  }
  defaultRuntime.log(
    `${theme.warn("Cleared")} ${removedDeviceIds.length} paired device${removedDeviceIds.length === 1 ? "" : "s"}`,
  );
  if (opts.pending) {
    defaultRuntime.log(
      `${theme.warn("Rejected")} ${rejectedRequestIds.length} pending request${rejectedRequestIds.length === 1 ? "" : "s"}`,
    );
  }
}

export async function runDevicesApproveCommand(
  requestId: string | undefined,
  opts: DevicesRpcOpts,
): Promise<void> {
  let pairingList: DevicePairingList | null = null;
  let resolvedRequestId = requestId?.trim();
  const usingImplicitSelection = !resolvedRequestId || Boolean(opts.latest);
  let selectedRequest: PendingDevice | null = null;
  if (usingImplicitSelection) {
    pairingList = await listPairingWithFallback(opts);
    selectedRequest = selectLatestPendingRequest(pairingList.pending);
    resolvedRequestId = selectedRequest?.requestId?.trim();
  }
  if (!resolvedRequestId) {
    failDevicesCommand(opts.json, "No pending device pairing requests to approve");
    return;
  }
  if (usingImplicitSelection) {
    // Keep implicit selection preview-only. A second command with the exact
    // requestId binds the approval to the request the operator inspected.
    const req = selectedRequest!;
    const approval = resolvePendingDeviceApprovalState(
      req,
      lookupPairedDevice(indexPairedDevices(pairingList?.paired), req),
    );
    const approveCommand = formatPairingApproveCommand("devices", req.requestId, opts);
    const authReminder = formatAuthFlagReminder(opts);
    if (opts.json) {
      defaultRuntime.writeJson({
        selected: req,
        approvalState: {
          kind: approval.kind,
          requested: approval.requested,
          approved: approval.approved,
        },
        approveCommand,
        requiresAuthFlags: {
          token: Boolean(normalizeOptionalString(opts.token)),
          password: Boolean(normalizeOptionalString(opts.password)),
        },
      });
      defaultRuntime.exit(1);
      return;
    }
    defaultRuntime.log(
      `${theme.warn("Selected pending device request")} ${theme.command(req.requestId)}`,
    );
    defaultRuntime.log(`  Device: ${formatPendingDeviceIdentity(req)}`);
    defaultRuntime.log(`  Requested: ${formatAccessSummary(approval.requested)}`);
    if (approval.approved) {
      defaultRuntime.log(`  Approved: ${formatAccessSummary(approval.approved)}`);
    }
    if (req.remoteIp) {
      defaultRuntime.log(`  IP:     ${sanitizeForLog(req.remoteIp)}`);
    }
    defaultRuntime.log(`  Note:   ${PENDING_APPROVAL_COPY[approval.kind].note}`);
    defaultRuntime.error(`Approve this exact request with: ${approveCommand}`);
    if (authReminder) {
      defaultRuntime.error(authReminder);
    }
    defaultRuntime.exit(1);
    return;
  }
  let result: Record<string, unknown> | null;
  const approvalContext = await resolveApprovePairingGatewayContext(opts, resolvedRequestId);
  try {
    result = await approvePairingWithFallback(opts, resolvedRequestId, approvalContext);
  } catch (error) {
    if (isScopeUpgradePendingApproval(error)) {
      failDevicesCommand(
        opts.json,
        "This device can't approve its own scope upgrade. Approve it from the Control UI or another authorized device.",
      );
      return;
    }
    throw error;
  }
  if (!result) {
    const message = `No pending device request matches ${sanitizeForLog(resolvedRequestId)}. Run ${formatCliCommand("openclaw devices list")} and retry with the current request ID.`;
    const nodeApprovalNotices = findPairedDevicePendingNodeApprovalNotices(
      opts,
      approvalContext.pairingList?.paired.filter((device) =>
        pairedDeviceMatchesNodeApprovalQuery(device, resolvedRequestId),
      ),
    );
    failDevicesCommand(opts.json, message, ...nodeApprovalNotices);
    return;
  }
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  const resultRequestId = (result as { requestId?: unknown })?.requestId;
  const approvedRequestId =
    typeof resultRequestId === "string" && resultRequestId.trim().length > 0
      ? resultRequestId
      : resolvedRequestId;
  const deviceId = (result as { device?: { deviceId?: string } })?.device?.deviceId;
  defaultRuntime.log(
    `${theme.success("Approved")} ${theme.command(deviceId ?? "ok")} ${theme.muted(`(${approvedRequestId})`)}`,
  );
}

export async function runDevicesRenameCommand(opts: DevicesRpcOpts): Promise<void> {
  const deviceId = normalizeStringifiedOptionalString(opts.device) ?? "";
  const label = normalizeStringifiedOptionalString(opts.name) ?? "";
  if (!deviceId || !label) {
    failDevicesCommand(
      opts.json,
      `--device and --name are required. Run ${formatCliCommand("openclaw devices list")} to choose a paired device.`,
    );
    return;
  }
  const result = await callGatewayCli("device.pair.rename", opts, { deviceId, label });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(
    `${theme.success("Renamed")} ${theme.command(deviceId)} ${theme.muted("→")} ${sanitizeForLog(label)}`,
  );
}

export async function runDevicesTokenCommand(
  operation: "rotate" | "revoke",
  opts: DevicesRpcOpts,
): Promise<void> {
  const required = resolveRequiredDeviceRole(opts);
  if (!required) {
    return;
  }
  const requestedScopes =
    operation === "rotate" ? (opts.scopes === false ? [] : opts.scope) : undefined;
  const params = operation === "rotate" ? { ...required, scopes: requestedScopes } : required;
  const scopes = await resolveTokenManagementScopes(opts, required, requestedScopes);
  const result = await callGatewayCli(`device.token.${operation}`, opts, params, { scopes });
  defaultRuntime.writeJson(result);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
