import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.ts";
import type {
  ChannelAccountSnapshot,
  ChannelsPairingApproveResult,
  ChannelsPairingListResult,
  ChannelsStatusSnapshot,
} from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";

type ChannelGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ChannelLogoutResult = {
  cleared: boolean;
};

type ChannelGatewaySnapshot = {
  client: ChannelGatewayClient | null;
  phase: ApplicationGatewayPhase;
  hello?: {
    auth?: { role?: string; scopes?: readonly string[] } | null;
  } | null;
};

type ChannelGateway = {
  readonly snapshot: ChannelGatewaySnapshot;
  subscribe: (listener: (snapshot: ChannelGatewaySnapshot) => void) => () => void;
};

export type ChannelsState = {
  client: ChannelGatewayClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsLoadingProbe?: boolean | null;
  channelsRefreshSeq?: number;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  pairingLoading: boolean;
  pairingRefreshSeq: number;
  pairingSnapshot: ChannelsPairingListResult | null;
  pairingError: string | null;
  pairingLastSuccess: number | null;
  pairingBusyRequestId: string | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginSessionKey: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
};

export type ChannelCapability = {
  readonly state: ChannelsState;
  refresh: (probe?: boolean) => Promise<void>;
  refreshPairing: () => Promise<void>;
  approvePairing: (params: {
    channel: string;
    accountId: string;
    requestId: string;
    notify: boolean;
    bootstrapCommandOwner: boolean;
  }) => Promise<ChannelsPairingApproveResult | null>;
  dismissPairing: (params: {
    channel: string;
    accountId: string;
    requestId: string;
  }) => Promise<boolean>;
  startWhatsApp: (force: boolean, accountId?: string) => Promise<void>;
  waitWhatsApp: (accountId?: string) => Promise<void>;
  logoutWhatsApp: (accountId?: string) => Promise<void>;
  subscribe: (listener: (state: ChannelsState) => void) => () => void;
  dispose: () => void;
};

export function resolveChannelAccounts(
  channelAccounts: ChannelsStatusSnapshot["channelAccounts"] | null | undefined,
  channelId: string,
): ChannelAccountSnapshot[] {
  const accounts =
    channelAccounts && Object.hasOwn(channelAccounts, channelId) && channelAccounts[channelId];
  return Array.isArray(accounts) ? accounts : [];
}

export function channelSnapshotEntryIsActive(
  snapshot: ChannelsStatusSnapshot | null,
  channelId: string,
): boolean {
  if (!snapshot) {
    return false;
  }
  const status = asRecord(
    Object.hasOwn(snapshot.channels, channelId) ? snapshot.channels[channelId] : undefined,
  );
  if (status?.configured === true || status?.running === true || status?.connected === true) {
    return true;
  }
  return resolveChannelAccounts(snapshot.channelAccounts, channelId).some(
    (account) =>
      account.configured === true || account.running === true || account.connected === true,
  );
}

/** Matches the Channels hub's definition of a transport the operator already uses. */
export function channelSnapshotHasActiveChannel(snapshot: ChannelsStatusSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }
  const channelIds = new Set([
    ...snapshot.channelOrder,
    ...Object.keys(snapshot.channels),
    ...Object.keys(snapshot.channelAccounts),
  ]);
  return [...channelIds].some((channelId) => channelSnapshotEntryIsActive(snapshot, channelId));
}

export function resolveChannelConfigValue(
  configForm: Record<string, unknown> | null | undefined,
  channelId: string,
): Record<string, unknown> | null {
  if (!configForm) {
    return null;
  }
  const channels = asRecord(configForm.channels);
  return asRecord(channels?.[channelId]) ?? asRecord(configForm[channelId]);
}

export function formatChannelExtraValue(raw: unknown): string {
  if (raw == null) {
    return t("common.na");
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return t("common.na");
  }
}

export function resolveChannelExtras(params: {
  configForm: Record<string, unknown> | null | undefined;
  channelId: string;
  fields: readonly string[];
}): Array<{ label: string; value: string }> {
  const value = resolveChannelConfigValue(params.configForm, params.channelId);
  if (!value) {
    return [];
  }
  return params.fields.flatMap((field) =>
    field in value ? [{ label: field, value: formatChannelExtraValue(value[field]) }] : [],
  );
}

export function resolveChannelPairingAuthSignature(
  snapshot: Partial<ChannelGatewaySnapshot>,
): string {
  const auth = snapshot.hello?.auth;
  return JSON.stringify({
    role: auth?.role ?? null,
    scopes: auth?.scopes ? [...auth.scopes].toSorted() : null,
  });
}

function channelSnapshotAllowsScope(
  snapshot: Partial<ChannelGatewaySnapshot>,
  scope: string,
): boolean {
  const auth = snapshot.hello?.auth;
  if (!auth?.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: [scope],
    allowedScopes: auth.scopes,
  });
}

function createInitialChannelsState(snapshot: Partial<ChannelGatewaySnapshot> = {}): ChannelsState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.phase === "connected",
    channelsLoading: false,
    channelsLoadingProbe: null,
    channelsRefreshSeq: 0,
    channelsSnapshot: null,
    channelsError: null,
    channelsLastSuccess: null,
    pairingLoading: false,
    pairingRefreshSeq: 0,
    pairingSnapshot: null,
    pairingError: null,
    pairingLastSuccess: null,
    pairingBusyRequestId: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginSessionKey: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
  };
}

function isCurrentChannelRefresh(
  state: ChannelsState,
  client: ChannelGatewayClient,
  refreshSeq: number,
): boolean {
  return state.client === client && state.channelsRefreshSeq === refreshSeq;
}

async function loadChannels(state: ChannelsState, probe: boolean) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.channelsLoading && (!state.channelsLoadingProbe || probe)) {
    return;
  }
  const refreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
  state.channelsRefreshSeq = refreshSeq;
  state.channelsLoading = true;
  state.channelsLoadingProbe = probe;
  try {
    const res = await client.request<ChannelsStatusSnapshot | null>("channels.status", {
      probe,
      timeoutMs: 8000,
    });
    if (!isCurrentChannelRefresh(state, client, refreshSeq)) {
      return;
    }
    state.channelsSnapshot = res;
    state.channelsError = null;
    state.channelsLastSuccess = Date.now();
  } catch (err) {
    if (!isCurrentChannelRefresh(state, client, refreshSeq)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.channelsSnapshot = null;
      state.channelsError = formatMissingOperatorReadScopeMessage("channel status");
    } else {
      state.channelsError = formatUiError(err);
    }
  } finally {
    if (isCurrentChannelRefresh(state, client, refreshSeq)) {
      state.channelsLoading = false;
      state.channelsLoadingProbe = null;
    }
  }
}

function isCurrentPairingRefresh(
  state: ChannelsState,
  client: ChannelGatewayClient,
  refreshSeq: number,
): boolean {
  return state.connected && state.client === client && state.pairingRefreshSeq === refreshSeq;
}

function invalidatePairingRefresh(state: ChannelsState): void {
  // A mutation must supersede any list that started before it; otherwise that
  // stale list can put the resolved request back until the next poll.
  state.pairingRefreshSeq += 1;
  state.pairingLoading = false;
}

async function loadChannelPairing(
  state: ChannelsState,
  options: { duringMutation?: boolean } = {},
): Promise<void> {
  const client = state.client;
  if (
    !client ||
    !state.connected ||
    state.pairingLoading ||
    (state.pairingBusyRequestId && !options.duringMutation)
  ) {
    return;
  }
  const refreshSeq = state.pairingRefreshSeq + 1;
  state.pairingRefreshSeq = refreshSeq;
  state.pairingLoading = true;
  state.pairingError = null;
  try {
    const snapshot = await client.request<ChannelsPairingListResult>("channels.pairing.list", {});
    if (!isCurrentPairingRefresh(state, client, refreshSeq)) {
      return;
    }
    state.pairingSnapshot = snapshot;
    state.pairingLastSuccess = Date.now();
  } catch (error) {
    if (isCurrentPairingRefresh(state, client, refreshSeq)) {
      state.pairingError = formatUiError(error);
    }
  } finally {
    if (isCurrentPairingRefresh(state, client, refreshSeq)) {
      state.pairingLoading = false;
    }
  }
}

function removePairingRequestFromSnapshot(state: ChannelsState, requestId: string): void {
  const snapshot = state.pairingSnapshot;
  if (!snapshot || !snapshot.requests.some((request) => request.requestId === requestId)) {
    return;
  }
  state.pairingSnapshot = {
    ...snapshot,
    requests: snapshot.requests.filter((request) => request.requestId !== requestId),
  };
}

async function mutateChannelPairing<T>(
  state: ChannelsState,
  params: Parameters<ChannelCapability["dismissPairing"]>[0],
  request: (client: ChannelGatewayClient) => Promise<T>,
): Promise<{ result: T } | null> {
  const client = state.client;
  if (!client || !state.connected || state.pairingBusyRequestId) {
    return null;
  }
  const requestId = params.requestId;
  const pairingEpoch = getChannelsLifecycle(state).pairingEpoch;
  const isCurrent = () =>
    state.connected &&
    state.client === client &&
    getChannelsLifecycle(state).pairingEpoch === pairingEpoch &&
    state.pairingBusyRequestId === requestId;
  invalidatePairingRefresh(state);
  state.pairingBusyRequestId = params.requestId;
  state.pairingError = null;
  try {
    const result = await request(client);
    if (!isCurrent()) {
      return null;
    }
    removePairingRequestFromSnapshot(state, params.requestId);
    invalidatePairingRefresh(state);
    await loadChannelPairing(state, { duringMutation: true });
    return isCurrent() ? { result } : null;
  } catch (error) {
    if (isCurrent()) {
      state.pairingError = formatUiError(error);
    }
    return null;
  } finally {
    if (isCurrent()) {
      state.pairingBusyRequestId = null;
    }
  }
}

type ChannelsLifecycle = {
  whatsappEpoch: number;
  pairingEpoch: number;
  whatsappOperationSeq: number;
};

const channelsLifecycles = new WeakMap<ChannelsState, ChannelsLifecycle>();

function getChannelsLifecycle(state: ChannelsState): ChannelsLifecycle {
  const existing = channelsLifecycles.get(state);
  if (existing) {
    return existing;
  }
  const created = { whatsappEpoch: 0, pairingEpoch: 0, whatsappOperationSeq: 0 };
  channelsLifecycles.set(state, created);
  return created;
}

async function runWhatsAppRequest<T>(
  state: ChannelsState,
  request: (client: ChannelGatewayClient) => Promise<T>,
  onResult: (result: T) => void,
  onError?: () => void,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.whatsappBusy) {
    return false;
  }
  const lifecycle = getChannelsLifecycle(state);
  const operationSeq = lifecycle.whatsappOperationSeq + 1;
  lifecycle.whatsappOperationSeq = operationSeq;
  state.whatsappBusy = true;
  const whatsappEpoch = lifecycle.whatsappEpoch;
  const isCurrent = () =>
    state.connected &&
    state.client === client &&
    lifecycle.whatsappEpoch === whatsappEpoch &&
    lifecycle.whatsappOperationSeq === operationSeq;
  try {
    const result = await request(client);
    if (!isCurrent()) {
      return false;
    }
    onResult(result);
  } catch (err) {
    if (isCurrent()) {
      state.whatsappLoginMessage = formatUiError(err);
      onError?.();
    }
    return false;
  } finally {
    if (isCurrent()) {
      state.whatsappBusy = false;
    }
  }
  return true;
}

function startWhatsAppLogin(state: ChannelsState, force: boolean, accountId?: string) {
  return runWhatsAppRequest(
    state,
    (client) =>
      client.request<{
        message?: string;
        qrDataUrl?: string;
        sessionKey?: string;
        connected?: boolean;
      }>("web.login.start", {
        channel: "whatsapp",
        force,
        timeoutMs: 30000,
        ...(accountId ? { accountId } : {}),
      }),
    (res) => {
      state.whatsappLoginSessionKey = res.connected ? null : (res.sessionKey ?? null);
      state.whatsappLoginMessage = res.message ? formatUiError(res.message) : null;
      state.whatsappLoginQrDataUrl = res.qrDataUrl ?? null;
      state.whatsappLoginConnected = typeof res.connected === "boolean" ? res.connected : null;
    },
    () => {
      state.whatsappLoginQrDataUrl = null;
      state.whatsappLoginSessionKey = null;
      state.whatsappLoginConnected = null;
    },
  );
}

function waitWhatsAppLogin(state: ChannelsState, accountId?: string) {
  return runWhatsAppRequest(
    state,
    (client) =>
      client.request<{
        message?: string;
        connected?: boolean;
        qrDataUrl?: string;
      }>("web.login.wait", {
        channel: "whatsapp",
        timeoutMs: 120000,
        currentQrDataUrl: state.whatsappLoginQrDataUrl ?? undefined,
        ...(state.whatsappLoginSessionKey ? { sessionKey: state.whatsappLoginSessionKey } : {}),
        ...(accountId ? { accountId } : {}),
      }),
    (res) => {
      state.whatsappLoginMessage = res.message ? formatUiError(res.message) : null;
      state.whatsappLoginConnected = res.connected ?? null;
      if (res.connected) {
        state.whatsappLoginSessionKey = null;
      }
      if (res.qrDataUrl) {
        state.whatsappLoginQrDataUrl = res.qrDataUrl;
      } else if (res.connected) {
        state.whatsappLoginQrDataUrl = null;
      }
    },
    () => {
      state.whatsappLoginConnected = null;
    },
  );
}

function logoutWhatsApp(state: ChannelsState, accountId?: string) {
  return runWhatsAppRequest(
    state,
    (client) =>
      client.request<ChannelLogoutResult>("channels.logout", {
        channel: "whatsapp",
        ...(accountId ? { accountId } : {}),
      }),
    (result) => {
      if (result.cleared) {
        state.whatsappLoginMessage = t("channels.whatsapp.loggedOut");
        state.whatsappLoginQrDataUrl = null;
        state.whatsappLoginSessionKey = null;
        state.whatsappLoginConnected = null;
      } else {
        state.whatsappLoginMessage = t("channels.whatsapp.logoutNotCleared");
      }
    },
  );
}

export function createChannelCapability(gateway: ChannelGateway): ChannelCapability {
  const state = createInitialChannelsState(gateway.snapshot);
  const listeners = new Set<(state: ChannelsState) => void>();
  let currentChannelReadAccess = channelSnapshotAllowsScope(gateway.snapshot, "operator.read");
  let currentPairingAuthSignature = resolveChannelPairingAuthSignature(gateway.snapshot);
  let currentWhatsAppAdminAccess = channelSnapshotAllowsScope(gateway.snapshot, "operator.admin");
  let disposed = false;

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const run = async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (disposed) {
      return undefined;
    }
    const result = task();
    publish();
    try {
      return await result;
    } finally {
      publish();
    }
  };
  const runWhatsApp = (task: () => Promise<boolean>) =>
    run(async () => {
      if (await task()) {
        await loadChannels(state, true);
      }
    });
  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connected = snapshot.phase === "connected";
    const connectionChanged = state.connected !== connected;
    const nextChannelReadAccess = channelSnapshotAllowsScope(snapshot, "operator.read");
    const channelReadAccessChanged = currentChannelReadAccess !== nextChannelReadAccess;
    currentChannelReadAccess = nextChannelReadAccess;
    const nextPairingAuthSignature = resolveChannelPairingAuthSignature(snapshot);
    const pairingAuthChanged = currentPairingAuthSignature !== nextPairingAuthSignature;
    currentPairingAuthSignature = nextPairingAuthSignature;
    const nextWhatsAppAdminAccess = channelSnapshotAllowsScope(snapshot, "operator.admin");
    const whatsappAdminAccessChanged = currentWhatsAppAdminAccess !== nextWhatsAppAdminAccess;
    currentWhatsAppAdminAccess = nextWhatsAppAdminAccess;
    state.client = snapshot.client;
    state.connected = connected;
    const lifecycle = getChannelsLifecycle(state);
    if (clientChanged || connectionChanged || channelReadAccessChanged) {
      state.channelsLoading = false;
      state.channelsLoadingProbe = null;
      state.channelsRefreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
      state.channelsError = connected || !nextChannelReadAccess ? null : state.channelsError;
      state.channelsSnapshot = null;
      state.channelsLastSuccess = null;
    }
    if (clientChanged || connectionChanged || whatsappAdminAccessChanged) {
      lifecycle.whatsappEpoch += 1;
      lifecycle.whatsappOperationSeq += 1;
      state.whatsappBusy = false;
      state.whatsappLoginSessionKey = null;
      if (!nextWhatsAppAdminAccess) {
        state.whatsappLoginMessage = null;
        state.whatsappLoginQrDataUrl = null;
        state.whatsappLoginConnected = null;
      }
    }
    if (clientChanged || connectionChanged || pairingAuthChanged) {
      // Pairing authorization has its own epoch so scope changes cannot cancel
      // unrelated channel login/logout operations on the same connection.
      lifecycle.pairingEpoch += 1;
      state.pairingSnapshot = null;
      state.pairingError = null;
      state.pairingLastSuccess = null;
      state.pairingLoading = false;
      state.pairingBusyRequestId = null;
      state.pairingRefreshSeq += 1;
    }
    publish();
  });

  return {
    get state() {
      return state;
    },
    refresh: (probe) => run(() => loadChannels(state, probe ?? false)),
    refreshPairing: () => run(() => loadChannelPairing(state)),
    approvePairing: async (params) => {
      const mutation = await run(() =>
        mutateChannelPairing(state, params, (client) =>
          client.request<ChannelsPairingApproveResult>("channels.pairing.approve", params),
        ),
      );
      return mutation ? mutation.result : null;
    },
    dismissPairing: async (params) =>
      Boolean(
        await run(() =>
          mutateChannelPairing(state, params, (client) =>
            client.request("channels.pairing.dismiss", params),
          ),
        ),
      ),
    startWhatsApp: (force, accountId) =>
      runWhatsApp(() => startWhatsAppLogin(state, force, accountId)),
    waitWhatsApp: (accountId) => runWhatsApp(() => waitWhatsAppLogin(state, accountId)),
    logoutWhatsApp: (accountId) => runWhatsApp(() => logoutWhatsApp(state, accountId)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const lifecycle = getChannelsLifecycle(state);
      lifecycle.whatsappEpoch += 1;
      lifecycle.pairingEpoch += 1;
      lifecycle.whatsappOperationSeq += 1;
      state.pairingRefreshSeq += 1;
      state.pairingBusyRequestId = null;
      state.whatsappBusy = false;
      stopGateway();
      listeners.clear();
    },
  };
}
