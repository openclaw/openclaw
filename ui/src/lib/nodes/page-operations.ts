// Presentation-free by contract: confirmations and secret reveals belong to the owning
// page, because native window.confirm/window.prompt silently answer in webviews with no
// dialog bridge and would end the action with no outcome and no recorded reason.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ExecApprovalsNodeSnapshot as GatewayExecApprovalsNodeSnapshot,
  ExecApprovalsSnapshot as GatewayExecApprovalsSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import type { DevicePairingList } from "../../../../src/gateway/device-pairing-list.types.js";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import { removePathValue, setPathValue } from "../config-form-utils.ts";
import { formatUiError } from "../format-error.ts";
import { clearDeviceAuthToken, loadOrCreateDeviceIdentity, storeDeviceAuthToken } from "./index.ts";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type NodesGatewaySnapshot = {
  client: GatewayRequestClient | null;
  connected: boolean;
};

type WireExecApprovalsFile = GatewayExecApprovalsSnapshot["file"];
type WireExecApprovalsAgent = NonNullable<WireExecApprovalsFile["agents"]>[string];

export type ExecApprovalsResolvedDefaults = NonNullable<
  GatewayExecApprovalsSnapshot["resolvedDefaults"]
>;
export type ExecSecurity = ExecApprovalsResolvedDefaults["security"];
export type ExecAsk = ExecApprovalsResolvedDefaults["ask"];
// Editor choices stay closed even though the wire accepts policy strings for host normalization.
type ExecApprovalsDefaults = Partial<ExecApprovalsResolvedDefaults>;

type ExecApprovalsAgent = ExecApprovalsDefaults & Pick<WireExecApprovalsAgent, "allowlist">;

export type ExecApprovalsFile = {
  version?: number;
  socket?: Pick<NonNullable<WireExecApprovalsFile["socket"]>, "path">;
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

type FileExecApprovalsSnapshot = Omit<GatewayExecApprovalsSnapshot, "file"> & {
  file: ExecApprovalsFile;
};

type NativeExecApprovalRule = NonNullable<GatewayExecApprovalsNodeSnapshot["rules"]>[number];

export type NativeExecApprovalsSnapshot =
  | {
      enabled: true;
      hash: string;
      baseHash?: string;
      defaultAction: NativeExecApprovalRule["action"];
      rules: NativeExecApprovalRule[];
      constraints?: Record<string, boolean>;
    }
  | { enabled: false; message?: string };

export type ExecApprovalsSnapshot = FileExecApprovalsSnapshot | NativeExecApprovalsSnapshot;

export type ExecApprovalsTarget = { kind: "gateway" } | { kind: "node"; nodeId: string };

type NodesRequestState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  // Auto-reconnect keeps the same client; the page advances this generation
  // whenever requests from the previous connection must become inert.
  requestGeneration: number;
};

type QueuedRefresh = "none" | "quiet" | "visible";

type NodesState = NodesRequestState & {
  nodesLoading: boolean;
  nodesQueuedRefresh: QueuedRefresh;
  nodes: Array<Record<string, unknown>>;
  lastError: string | null;
  chatError?: string | null;
};

type DevicesState = NodesRequestState & {
  devicesLoading: boolean;
  devicesQueuedRefresh: QueuedRefresh;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
};

type ExecApprovalsState = NodesRequestState & {
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  lastError: string | null;
  chatError?: string | null;
};

export type DevicesPageDataState = NodesState & DevicesState & ExecApprovalsState;

export function createInitialDevicesState(
  snapshot: Partial<NodesGatewaySnapshot> = {},
): DevicesPageDataState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    requestGeneration: 0,
    nodesLoading: false,
    nodesQueuedRefresh: "none",
    nodes: [],
    lastError: null,
    devicesLoading: false,
    devicesQueuedRefresh: "none",
    devicesError: null,
    devicesList: null,
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
  };
}

function isCurrentNodesRequest(
  state: NodesRequestState,
  client: GatewayRequestClient,
  generation: number,
): boolean {
  return state.connected && state.client === client && state.requestGeneration === generation;
}

function queueRefresh(current: QueuedRefresh, quiet: boolean | undefined): QueuedRefresh {
  return current === "visible" || quiet !== true ? "visible" : "quiet";
}

export async function loadNodes(state: NodesState, opts?: { quiet?: boolean }) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.nodesLoading) {
    state.nodesQueuedRefresh = queueRefresh(state.nodesQueuedRefresh, opts?.quiet);
    return;
  }
  state.nodesLoading = true;
  if (!opts?.quiet) {
    state.lastError = null;
    state.chatError = null;
  }
  const generation = state.requestGeneration;
  try {
    const res = await client.request<{ nodes?: NodeListNode[] }>("node.list", {});
    if (isCurrentNodesRequest(state, client, generation)) {
      state.nodes = Array.isArray(res.nodes) ? res.nodes : [];
    }
  } catch (err) {
    if (!opts?.quiet && isCurrentNodesRequest(state, client, generation)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.nodesLoading = false;
      const queued = state.nodesQueuedRefresh;
      state.nodesQueuedRefresh = "none";
      if (queued !== "none") {
        await loadNodes(state, { quiet: queued === "quiet" });
      }
    }
  }
}

export async function loadDevices(state: DevicesState, opts?: { quiet?: boolean }) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.devicesLoading) {
    state.devicesQueuedRefresh = queueRefresh(state.devicesQueuedRefresh, opts?.quiet);
    return;
  }
  state.devicesLoading = true;
  if (!opts?.quiet) {
    state.devicesError = null;
  }
  const generation = state.requestGeneration;
  try {
    const res = await client.request<Partial<DevicePairingList>>("device.pair.list", {});
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesList = {
        pending: Array.isArray(res?.pending) ? res.pending : [],
        paired: Array.isArray(res?.paired) ? res.paired : [],
      };
    }
  } catch (err) {
    if (!opts?.quiet && isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesLoading = false;
      const queued = state.devicesQueuedRefresh;
      state.devicesQueuedRefresh = "none";
      if (queued !== "none") {
        await loadDevices(state, { quiet: queued === "quiet" });
      }
    }
  }
}

// Persist accepted mutations before fencing their captured connection's view refresh.
async function runDeviceMutation<T>(
  state: DevicesState,
  mutate: (client: GatewayRequestClient) => Promise<T>,
): Promise<T | null> {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  const generation = state.requestGeneration;
  try {
    const result = await mutate(client);
    if (isCurrentNodesRequest(state, client, generation)) {
      await loadDevices(state);
    }
    return result;
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = formatUiError(err);
    }
    return null;
  }
}

export async function approveDevicePairing(state: DevicesState, requestId: string) {
  await runDeviceMutation(state, (client) => client.request("device.pair.approve", { requestId }));
}

export async function rejectDevicePairing(state: DevicesState, requestId: string) {
  await runDeviceMutation(state, (client) => client.request("device.pair.reject", { requestId }));
}

/** Entry removal request resolved from the unified inventory row. */
export type InventoryRemovalRequest = {
  id: string;
  name: string;
  removeNode: boolean;
  removeDevice: boolean;
};

type InventoryState = NodesState & DevicesState;

async function removeInventoryEntryRpc(
  client: GatewayRequestClient,
  entry: InventoryRemovalRequest,
) {
  // Node removal first: it revokes the node role (deleting node-only device rows)
  // and clears any legacy node pairing under the same id. A mixed-role record
  // then loses its remaining roles via the device-level removal.
  if (entry.removeNode) {
    await client.request("node.pair.remove", { nodeId: entry.id });
  }
  if (entry.removeDevice) {
    await client.request("device.pair.remove", { deviceId: entry.id });
  }
}

// Reload quietly and assign the failure afterwards: a non-quiet loadDevices
// clears devicesError first, which would erase the message before it renders.
async function reloadInventory(state: InventoryState, opts?: { error?: string }) {
  const quiet = opts?.error !== undefined;
  await Promise.all([loadDevices(state, { quiet }), loadNodes(state, { quiet })]);
  if (opts?.error !== undefined) {
    state.devicesError = opts.error;
  }
}

// Inventory mutations refresh the current connection, including after failed partial removals.
async function runInventoryMutation(
  state: InventoryState,
  mutate: (client: GatewayRequestClient) => Promise<unknown>,
) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  try {
    await mutate(client);
    await reloadInventory(state);
  } catch (err) {
    await reloadInventory(state, { error: formatUiError(err) });
  }
}

export function removeInventoryEntry(state: InventoryState, entry: InventoryRemovalRequest) {
  return runInventoryMutation(state, (client) => removeInventoryEntryRpc(client, entry));
}

export async function removeStaleInventoryEntries(
  state: InventoryState,
  entries: InventoryRemovalRequest[],
) {
  const client = state.client;
  if (!client || !state.connected || entries.length === 0) {
    return;
  }
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      await removeInventoryEntryRpc(client, entry);
    } catch (err) {
      failures.push(`${entry.name}: ${formatUiError(err)}`);
    }
  }
  await reloadInventory(
    state,
    failures.length > 0
      ? {
          error: `Failed to remove ${failures.length} entr${failures.length === 1 ? "y" : "ies"}: ${failures[0]}`,
        }
      : undefined,
  );
}

/** Null closes the rename dialog; an error leaves the attempted alias retryable. */
export async function renameDevice(
  state: DevicesState,
  params: { deviceId: string; label: string },
): Promise<string | null> {
  const client = state.client;
  if (!client || !state.connected) {
    const message = formatUiError(new Error("The Gateway connection is not available."));
    state.devicesError = message;
    return message;
  }
  const generation = state.requestGeneration;
  try {
    await client.request("device.pair.rename", params);
    if (isCurrentNodesRequest(state, client, generation)) {
      await loadDevices(state);
    }
    return null;
  } catch (err) {
    const message = formatUiError(err);
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = message;
    }
    return message;
  }
}

export function approveNodePairingRequest(state: InventoryState, requestId: string) {
  return runInventoryMutation(state, (client) =>
    client.request("node.pair.approve", { requestId }),
  );
}

export function rejectNodePairingRequest(state: InventoryState, requestId: string) {
  return runInventoryMutation(state, (client) => client.request("node.pair.reject", { requestId }));
}

/**
 * How a rotation ended, for the owning page to report. The Gateway echoes the bearer
 * token only to a device rotating its own token, so a cross-device rotation is a real
 * outcome with no secret to show rather than a failure.
 */
type RotatedDeviceTokenOutcome =
  | { delivery: "in-band"; token: string }
  | { delivery: "withheld-cross-device" };

/**
 * The Gateway echoes back the raw request `deviceId` and the stored `role`, so a returned
 * grant is compared on the same trim normalization the device-auth store applies
 * (`normalizeDeviceAuthRole`) rather than by raw equality.
 */
function matchesRequestedGrant(value: unknown, requested: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === requested.trim();
}

// Browser RPC responses are unvalidated. Require the requested grant and a matching
// delivery/secret pair before presenting either outcome: the old token is already dead.
function classifyRotationOutcome(
  payload: unknown,
  requested: { deviceId: string; role: string },
): RotatedDeviceTokenOutcome {
  const result = asOptionalRecord(payload);
  const scopes = result?.scopes;
  const rotatedAtMs = result?.rotatedAtMs;
  const identified =
    matchesRequestedGrant(result?.deviceId, requested.deviceId) &&
    matchesRequestedGrant(result?.role, requested.role) &&
    Array.isArray(scopes) &&
    scopes.every((scope: unknown) => typeof scope === "string" && scope.length > 0) &&
    typeof rotatedAtMs === "number" &&
    Number.isInteger(rotatedAtMs) &&
    rotatedAtMs >= 0;
  // An empty token is malformed, not a withheld secret.
  const rawToken = result?.token;
  const token = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined;
  const tokenAbsent = rawToken === undefined;
  const delivery = result?.tokenDelivery;
  if (identified) {
    if (token && (delivery === undefined || delivery === "in-band")) {
      return { delivery: "in-band", token };
    }
    if (tokenAbsent && (delivery === undefined || delivery === "withheld-cross-device")) {
      return { delivery: "withheld-cross-device" };
    }
  }
  throw new Error(
    `Rotation returned an unusable result (tokenDelivery=${JSON.stringify(delivery)}, token ${token ? "present" : tokenAbsent ? "absent" : "malformed"}). The previous token no longer works; pair the device again if it does not reconnect.`,
  );
}

/** Rotates a device token and returns what the Gateway did with the replacement. */
export async function rotateDeviceToken(
  state: DevicesState,
  params: { deviceId: string; gatewayUrl: string; role: string; scopes?: string[] },
): Promise<RotatedDeviceTokenOutcome | null> {
  return runDeviceMutation(state, async (client) => {
    const { gatewayUrl, ...requestParams } = params;
    const res = await client.request<{
      token?: string;
      role?: string;
      deviceId?: string;
      scopes?: Array<string>;
      tokenDelivery?: string;
    }>("device.token.rotate", requestParams);
    const outcome = classifyRotationOutcome(res, requestParams);
    if (outcome.delivery === "in-band") {
      const identity = await loadOrCreateDeviceIdentity();
      // RPC success retires the old bearer and may immediately reconnect the page.
      // Commit the exact captured credential scope before fencing render projections.
      if (res.deviceId === identity.deviceId || requestParams.deviceId === identity.deviceId) {
        storeDeviceAuthToken({
          deviceId: identity.deviceId,
          gatewayUrl,
          role: requestParams.role,
          token: outcome.token,
          scopes: res.scopes ?? requestParams.scopes ?? [],
        });
      }
    }
    return outcome;
  });
}

export async function revokeDeviceToken(
  state: DevicesState,
  params: { deviceId: string; gatewayUrl: string; role: string },
) {
  await runDeviceMutation(state, async (client) => {
    const { gatewayUrl, ...requestParams } = params;
    await client.request("device.token.revoke", requestParams);
    const identity = await loadOrCreateDeviceIdentity();
    // Clearing the successfully revoked credential belongs to this captured scope,
    // not to the page generation invalidated by the resulting reconnect.
    if (requestParams.deviceId === identity.deviceId) {
      clearDeviceAuthToken({
        deviceId: identity.deviceId,
        gatewayUrl,
        role: requestParams.role,
      });
    }
  });
}

function resolveExecApprovalsRpc(
  target: ExecApprovalsTarget | null | undefined,
  write?: { file: ExecApprovalsFile; baseHash: string },
): { method: string; params: Record<string, unknown> } | null {
  const operation = write ? "set" : "get";
  const params = write ?? {};
  if (!target || target.kind === "gateway") {
    return { method: `exec.approvals.${operation}`, params };
  }
  const nodeId = target.nodeId.trim();
  return nodeId
    ? { method: `exec.approvals.node.${operation}`, params: { ...params, nodeId } }
    : null;
}

export async function loadExecApprovals(
  state: ExecApprovalsState,
  target?: ExecApprovalsTarget | null,
) {
  const client = state.client;
  if (!client || !state.connected || state.execApprovalsLoading) {
    return;
  }
  state.execApprovalsLoading = true;
  state.lastError = null;
  state.chatError = null;
  const generation = state.requestGeneration;
  try {
    const rpc = resolveExecApprovalsRpc(target);
    if (!rpc) {
      state.lastError = "Select a node before loading exec approvals.";
      return;
    }
    const res = await client.request<ExecApprovalsSnapshot>(rpc.method, rpc.params);
    if (isCurrentNodesRequest(state, client, generation)) {
      applyExecApprovalsSnapshot(state, res);
    }
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.execApprovalsLoading = false;
    }
  }
}

function applyExecApprovalsSnapshot(state: ExecApprovalsState, snapshot: ExecApprovalsSnapshot) {
  state.execApprovalsSnapshot = snapshot;
  if (isNativeExecApprovalsSnapshot(snapshot)) {
    state.execApprovalsForm = null;
    state.execApprovalsDirty = false;
    return;
  }
  if (!state.execApprovalsDirty) {
    state.execApprovalsForm = structuredClone(snapshot.file);
  }
}

export function isNativeExecApprovalsSnapshot(
  snapshot: ExecApprovalsSnapshot | null | undefined,
): snapshot is NativeExecApprovalsSnapshot {
  return Boolean(snapshot && "enabled" in snapshot);
}

export async function saveExecApprovals(
  state: ExecApprovalsState,
  target?: ExecApprovalsTarget | null,
) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  state.execApprovalsSaving = true;
  state.lastError = null;
  state.chatError = null;
  const generation = state.requestGeneration;
  try {
    if (isNativeExecApprovalsSnapshot(state.execApprovalsSnapshot)) {
      state.lastError =
        "Host-native node approvals are read-only here; use the companion app or approvals set --node.";
      return;
    }
    const baseHash = state.execApprovalsSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Exec approvals hash missing; reload and retry.";
      return;
    }
    const file = state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {};
    const rpc = resolveExecApprovalsRpc(target, { file, baseHash });
    if (!rpc) {
      state.lastError = "Select a node before saving exec approvals.";
      return;
    }
    await client.request(rpc.method, rpc.params);
    if (!isCurrentNodesRequest(state, client, generation)) {
      return;
    }
    state.execApprovalsDirty = false;
    await loadExecApprovals(state, target);
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.execApprovalsSaving = false;
    }
  }
}

function mutateExecApprovalsForm(
  state: ExecApprovalsState,
  mutate: (form: ExecApprovalsFile) => void,
) {
  if (isNativeExecApprovalsSnapshot(state.execApprovalsSnapshot)) {
    state.lastError = "Host-native node approvals are read-only here.";
    return;
  }
  const base = structuredClone(state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {});
  mutate(base);
  state.execApprovalsForm = base;
  state.execApprovalsDirty = true;
}

export function updateExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
  value: unknown,
) {
  mutateExecApprovalsForm(state, (form) => setPathValue(form, path, value));
}

export function removeExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
) {
  mutateExecApprovalsForm(state, (form) => removePathValue(form, path));
}
