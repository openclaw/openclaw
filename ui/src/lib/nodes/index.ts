// Shared Nodes operations used by the Control UI page and Gateway event hooks.
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";
import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../../../../src/shared/device-auth-store.js";
import type { DeviceAuthStore } from "../../../../src/shared/device-auth.js";
import { normalizeGatewayCredentialScope } from "../../app/gateway-scope.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { cloneConfigObject, removePathValue, setPathValue } from "../config-form-utils.ts";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type NodesGatewaySnapshot = {
  client: GatewayRequestClient | null;
  connected: boolean;
};

export type DeviceTokenSummary = {
  role: string;
  scopes?: string[];
  createdAtMs?: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type PendingDevice = {
  requestId: string;
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  isRepair?: boolean;
  ts?: number;
};

export type PairedDevice = {
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceTokenSummary[];
  createdAtMs?: number;
  approvedAtMs?: number;
};

export type DevicePairingList = {
  pending: PendingDevice[];
  paired: PairedDevice[];
};

export type ExecApprovalsDefaults = {
  security?: string;
  ask?: string;
  askFallback?: string;
  autoAllowSkills?: boolean;
};

export type ExecApprovalsAllowlistEntry = {
  id?: string;
  pattern: string;
  source?: "allow-always";
  commandText?: string;
  argPattern?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecApprovalsAllowlistEntry[];
};

export type ExecApprovalsFile = {
  version?: number;
  socket?: { path?: string };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

export type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

export type ExecApprovalsTarget = { kind: "gateway" } | { kind: "node"; nodeId: string };

export type NodesState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  lastError: string | null;
  chatError?: string | null;
};

export type DevicesState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
};

export type ExecApprovalsState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  lastError: string | null;
  chatError?: string | null;
};

export type NodesPageDataState = NodesState & DevicesState & ExecApprovalsState;

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

const LEGACY_DEVICE_AUTH_STORAGE_KEY = "openclaw.device.auth.v1";
const DEVICE_AUTH_STORAGE_KEY_PREFIX = `${LEGACY_DEVICE_AUTH_STORAGE_KEY}:`;
const DEVICE_IDENTITY_STORAGE_KEY = "openclaw-device-identity-v1";

export function createInitialNodesState(
  snapshot: Partial<NodesGatewaySnapshot> = {},
): NodesPageDataState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    nodesLoading: false,
    nodes: [],
    lastError: null,
    devicesLoading: false,
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

export async function loadNodes(state: NodesState, opts?: { quiet?: boolean }) {
  const client = state.client;
  if (!client || !state.connected || state.nodesLoading) {
    return;
  }
  state.nodesLoading = true;
  if (!opts?.quiet) {
    state.lastError = null;
    state.chatError = null;
  }
  try {
    const res = await client.request<{ nodes?: unknown }>("node.list", {});
    if (state.client === client) {
      state.nodes = Array.isArray(res.nodes) ? (res.nodes as Array<Record<string, unknown>>) : [];
    }
  } catch (err) {
    if (!opts?.quiet && state.client === client) {
      state.lastError = String(err);
    }
  } finally {
    if (state.client === client) {
      state.nodesLoading = false;
    }
  }
}

export async function loadDevices(state: DevicesState, opts?: { quiet?: boolean }) {
  const client = state.client;
  if (!client || !state.connected || state.devicesLoading) {
    return;
  }
  state.devicesLoading = true;
  if (!opts?.quiet) {
    state.devicesError = null;
  }
  try {
    const res = await client.request<{
      pending?: Array<PendingDevice>;
      paired?: Array<PairedDevice>;
    }>("device.pair.list", {});
    if (state.client === client) {
      state.devicesList = {
        pending: Array.isArray(res?.pending) ? res.pending : [],
        paired: Array.isArray(res?.paired) ? res.paired : [],
      };
    }
  } catch (err) {
    if (!opts?.quiet && state.client === client) {
      state.devicesError = String(err);
    }
  } finally {
    if (state.client === client) {
      state.devicesLoading = false;
    }
  }
}

export async function approveDevicePairing(state: DevicesState, requestId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("device.pair.approve", { requestId });
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function rejectDevicePairing(state: DevicesState, requestId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const confirmed = window.confirm("Reject this device pairing request?");
  if (!confirmed) {
    return;
  }
  try {
    await state.client.request("device.pair.reject", { requestId });
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function rotateDeviceToken(
  state: DevicesState,
  params: { deviceId: string; gatewayUrl: string; role: string; scopes?: string[] },
) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const { gatewayUrl, ...requestParams } = params;
    const res = await state.client.request<{
      token?: string;
      role?: string;
      deviceId?: string;
      scopes?: Array<string>;
    }>("device.token.rotate", requestParams);
    if (res?.token) {
      const identity = await loadOrCreateDeviceIdentity();
      const role = res.role ?? params.role;
      if (res.deviceId === identity.deviceId || params.deviceId === identity.deviceId) {
        storeDeviceAuthToken({
          deviceId: identity.deviceId,
          gatewayUrl,
          role,
          token: res.token,
          scopes: res.scopes ?? params.scopes ?? [],
        });
      }
      window.prompt("New device token (copy and store securely):", res.token);
    }
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function revokeDeviceToken(
  state: DevicesState,
  params: { deviceId: string; gatewayUrl: string; role: string },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const confirmed = window.confirm(`Revoke token for ${params.deviceId} (${params.role})?`);
  if (!confirmed) {
    return;
  }
  try {
    const { gatewayUrl, ...requestParams } = params;
    await state.client.request("device.token.revoke", requestParams);
    const identity = await loadOrCreateDeviceIdentity();
    if (params.deviceId === identity.deviceId) {
      clearDeviceAuthToken({
        deviceId: identity.deviceId,
        gatewayUrl,
        role: params.role,
      });
    }
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

function resolveExecApprovalsRpc(target?: ExecApprovalsTarget | null): {
  method: string;
  params: Record<string, unknown>;
} | null {
  if (!target || target.kind === "gateway") {
    return { method: "exec.approvals.get", params: {} };
  }
  const nodeId = target.nodeId.trim();
  return nodeId ? { method: "exec.approvals.node.get", params: { nodeId } } : null;
}

function resolveExecApprovalsSaveRpc(
  target: ExecApprovalsTarget | null | undefined,
  params: { file: ExecApprovalsFile; baseHash: string },
): { method: string; params: Record<string, unknown> } | null {
  if (!target || target.kind === "gateway") {
    return { method: "exec.approvals.set", params };
  }
  const nodeId = target.nodeId.trim();
  return nodeId ? { method: "exec.approvals.node.set", params: { ...params, nodeId } } : null;
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
  try {
    const rpc = resolveExecApprovalsRpc(target);
    if (!rpc) {
      state.lastError = "Select a node before loading exec approvals.";
      return;
    }
    const res = await client.request<ExecApprovalsSnapshot>(rpc.method, rpc.params);
    if (state.client === client) {
      applyExecApprovalsSnapshot(state, res);
    }
  } catch (err) {
    if (state.client === client) {
      state.lastError = String(err);
    }
  } finally {
    if (state.client === client) {
      state.execApprovalsLoading = false;
    }
  }
}

function applyExecApprovalsSnapshot(state: ExecApprovalsState, snapshot: ExecApprovalsSnapshot) {
  state.execApprovalsSnapshot = snapshot;
  if (!state.execApprovalsDirty) {
    state.execApprovalsForm = cloneConfigObject(snapshot.file ?? {});
  }
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
  try {
    const baseHash = state.execApprovalsSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Exec approvals hash missing; reload and retry.";
      return;
    }
    const file = state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {};
    const rpc = resolveExecApprovalsSaveRpc(target, { file, baseHash });
    if (!rpc) {
      state.lastError = "Select a node before saving exec approvals.";
      return;
    }
    await client.request(rpc.method, rpc.params);
    if (state.client !== client) {
      return;
    }
    state.execApprovalsDirty = false;
    await loadExecApprovals(state, target);
  } catch (err) {
    if (state.client === client) {
      state.lastError = String(err);
    }
  } finally {
    if (state.client === client) {
      state.execApprovalsSaving = false;
    }
  }
}

export function updateExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
  value: unknown,
) {
  const base = cloneConfigObject(
    state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {},
  );
  setPathValue(base, path, value);
  state.execApprovalsForm = base;
  state.execApprovalsDirty = true;
}

export function removeExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
) {
  const base = cloneConfigObject(
    state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {},
  );
  removePathValue(base, path);
  state.execApprovalsForm = base;
  state.execApprovalsDirty = true;
}

function deviceAuthStorageKey(gatewayUrl: string): string {
  return `${DEVICE_AUTH_STORAGE_KEY_PREFIX}${normalizeGatewayCredentialScope(gatewayUrl)}`;
}

function removeLegacyDeviceAuthStore(storage: Storage | null) {
  try {
    storage?.removeItem(LEGACY_DEVICE_AUTH_STORAGE_KEY);
  } catch {
    // Legacy cleanup must not make an otherwise usable device token unreadable.
  }
}

function parseDeviceAuthStore(raw: string | null): DeviceAuthStore | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (!parsed || parsed.version !== 1) {
      return null;
    }
    if (!parsed.deviceId || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readStore(gatewayUrl: string): DeviceAuthStore | null {
  try {
    const storage = getSafeLocalStorage();
    const scopedKey = deviceAuthStorageKey(gatewayUrl);
    const scopedStore = parseDeviceAuthStore(storage?.getItem(scopedKey) ?? null);
    if (scopedStore) {
      removeLegacyDeviceAuthStore(storage);
      return scopedStore;
    }

    const legacyStore = parseDeviceAuthStore(
      storage?.getItem(LEGACY_DEVICE_AUTH_STORAGE_KEY) ?? null,
    );
    if (!legacyStore) {
      return null;
    }

    // Older releases stored one origin-wide token. Claim it for the first gateway
    // opened after upgrade, then remove the ambiguous key before sibling routes use it.
    try {
      storage?.setItem(scopedKey, JSON.stringify(legacyStore));
      removeLegacyDeviceAuthStore(storage);
    } catch {
      // Keep the usable in-memory result when browser storage rejects the migration.
    }
    return legacyStore;
  } catch {
    return null;
  }
}

function writeStore(gatewayUrl: string, store: DeviceAuthStore) {
  try {
    const storage = getSafeLocalStorage();
    storage?.setItem(deviceAuthStorageKey(gatewayUrl), JSON.stringify(store));
    removeLegacyDeviceAuthStore(storage);
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}): DeviceAuthEntry | null {
  return loadDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(params.gatewayUrl),
      writeStore: (store) => writeStore(params.gatewayUrl, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => readStore(params.gatewayUrl),
      writeStore: (store) => writeStore(params.gatewayUrl, store),
    },
    deviceId: params.deviceId,
    role: params.role,
    token: params.token,
    scopes: params.scopes,
  });
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}) {
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(params.gatewayUrl),
      writeStore: (store) => writeStore(params.gatewayUrl, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", publicKey.slice().buffer);
  return bytesToHex(new Uint8Array(hash));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = await fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
        if (derivedId !== parsed.deviceId) {
          const updated: StoredIdentity = {
            ...parsed,
            deviceId: derivedId,
          };
          storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(updated));
          return {
            deviceId: derivedId,
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        };
      }
    }
  } catch {
    // Invalid local identity is replaced below.
  }

  const identity = await generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  };
  storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored));
  return identity;
}

export async function signDevicePayload(privateKeyBase64Url: string, payload: string) {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await signAsync(data, key);
  return base64UrlEncode(sig);
}
