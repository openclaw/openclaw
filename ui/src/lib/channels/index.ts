import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ChannelsPairingApproveParams,
  ChannelsPairingDismissParams,
} from "../../../../packages/gateway-protocol/src/schema/channel-pairing.js";
import { registerListener } from "../../../../src/shared/listeners.js";
import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.ts";
import type { GatewayEventListener } from "../../api/gateway.ts";
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

type ChannelGatewaySnapshot = {
  client: ChannelGatewayClient | null;
  phase: ApplicationGatewayPhase;
  hello?: {
    auth?: { role?: string; scopes?: readonly string[] } | null;
  } | null;
};

/** One admitted read; retirement settles even when the transport never responds. */
export type ChannelRead = {
  readonly completion: Promise<string | null>;
};

export type ChannelsState = {
  client: ChannelGatewayClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsLoadingProbe?: boolean | null;
  channelsRefreshSeq?: number;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsRead: ChannelRead | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  pairingLoading: boolean;
  pairingRefreshSeq: number;
  pairingSnapshot: ChannelsPairingListResult | null;
  pairingRead: ChannelRead | null;
  /** Admitted mutation failure; read failures belong to their completion receipt. */
  pairingError: string | null;
  pairingLastSuccess: number | null;
  pairingBusyRequestId: string | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginSessionKey: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
};

export type ChannelCapability = ReturnType<typeof createChannelCapability>;

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

export function createChannelCapability(gateway: {
  readonly snapshot: ChannelGatewaySnapshot;
  subscribe: (listener: (snapshot: ChannelGatewaySnapshot) => void) => () => void;
  subscribeEvents: (listener: GatewayEventListener) => () => void;
}) {
  const initialSnapshot = gateway.snapshot;
  const state: ChannelsState = {
    client: initialSnapshot.client ?? null,
    connected: initialSnapshot.phase === "connected",
    channelsLoading: false,
    channelsLoadingProbe: null,
    channelsRefreshSeq: 0,
    channelsSnapshot: null,
    channelsRead: null,
    channelsError: null,
    channelsLastSuccess: null,
    pairingLoading: false,
    pairingRefreshSeq: 0,
    pairingSnapshot: null,
    pairingRead: null,
    pairingError: null,
    pairingLastSuccess: null,
    pairingBusyRequestId: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginSessionKey: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
  };
  const lifecycle = { whatsappEpoch: 0, pairingEpoch: 0 };
  let settlePairingRead: ((error: string | null) => void) | undefined;

  function invalidatePairingRefresh(): void {
    settlePairingRead?.(null);
    settlePairingRead = undefined;
    // A mutation must supersede any list that started before it; otherwise that
    // stale list can put the resolved request back until the next poll.
    state.pairingRefreshSeq += 1;
    state.pairingLoading = false;
  }

  async function loadChannelPairing(options: { duringMutation?: boolean } = {}): Promise<void> {
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
    const isCurrent = () =>
      state.connected && state.client === client && state.pairingRefreshSeq === refreshSeq;
    state.pairingRefreshSeq = refreshSeq;
    state.pairingLoading = true;
    state.pairingError = null;
    const { promise, resolve } = Promise.withResolvers<string | null>();
    settlePairingRead = resolve;
    state.pairingRead = { completion: promise };
    let failure: string | null = null;
    try {
      const snapshot = await client.request<ChannelsPairingListResult>("channels.pairing.list", {});
      if (!isCurrent()) {
        return;
      }
      state.pairingSnapshot = snapshot;
      state.pairingLastSuccess = Date.now();
    } catch (error) {
      failure = formatUiError(error);
    } finally {
      if (isCurrent()) {
        resolve(failure);
        settlePairingRead = undefined;
        state.pairingLoading = false;
      }
    }
  }

  async function mutateChannelPairing<T>(
    requestId: string,
    request: (client: ChannelGatewayClient) => Promise<T>,
  ): Promise<{ result: T } | null> {
    const client = state.client;
    if (!client || !state.connected || state.pairingBusyRequestId) {
      return null;
    }
    const pairingEpoch = lifecycle.pairingEpoch;
    const isCurrent = () =>
      state.connected &&
      state.client === client &&
      lifecycle.pairingEpoch === pairingEpoch &&
      state.pairingBusyRequestId === requestId;
    invalidatePairingRefresh();
    state.pairingBusyRequestId = requestId;
    state.pairingRead = null;
    state.pairingError = null;
    try {
      const result = await request(client);
      if (!isCurrent()) {
        return null;
      }
      const pairingSnapshot = state.pairingSnapshot;
      if (pairingSnapshot?.requests.some((row) => row.requestId === requestId)) {
        state.pairingSnapshot = {
          ...pairingSnapshot,
          requests: pairingSnapshot.requests.filter((row) => row.requestId !== requestId),
        };
      }
      invalidatePairingRefresh();
      await loadChannelPairing({ duringMutation: true });
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

  async function runWhatsAppRequest<T>(
    request: (client: ChannelGatewayClient) => Promise<T>,
    onResult: (result: T) => void,
    onError?: () => void,
  ): Promise<boolean> {
    const client = state.client;
    if (!client || !state.connected || state.whatsappBusy) {
      return false;
    }
    state.whatsappBusy = true;
    const whatsappEpoch = lifecycle.whatsappEpoch;
    const isCurrent = () =>
      state.connected && state.client === client && lifecycle.whatsappEpoch === whatsappEpoch;
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

  function startWhatsAppLogin(force: boolean, accountId?: string) {
    return runWhatsAppRequest(
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

  function waitWhatsAppLogin(accountId?: string) {
    return runWhatsAppRequest(
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

  function logoutWhatsApp(accountId?: string) {
    return runWhatsAppRequest(
      (client) =>
        client.request<{
          cleared: boolean;
        }>("channels.logout", {
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

  const listeners = new Set<(state: ChannelsState) => void>();
  let currentChannelReadAccess = channelSnapshotAllowsScope(gateway.snapshot, "operator.read");
  let currentPairingAuthSignature = resolveChannelPairingAuthSignature(gateway.snapshot);
  let currentWhatsAppAdminAccess = channelSnapshotAllowsScope(gateway.snapshot, "operator.admin");
  let disposed = false;
  let channelsInvalidated = false;
  let settleChannelRead: ((error: string | null) => void) | undefined;

  function retireChannelRead() {
    settleChannelRead?.(null);
    settleChannelRead = undefined;
    state.channelsRead = null;
  }

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
  async function loadChannels(probe: boolean): Promise<void> {
    const client = state.client;
    if (!client || !state.connected) {
      return;
    }
    if (state.channelsLoading && (!state.channelsLoadingProbe || probe)) {
      return;
    }
    const refreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
    const isCurrent = () => state.client === client && state.channelsRefreshSeq === refreshSeq;
    state.channelsRefreshSeq = refreshSeq;
    state.channelsLoading = true;
    state.channelsLoadingProbe = probe;
    if (!probe) {
      channelsInvalidated = false;
    }
    retireChannelRead();
    const { promise, resolve } = Promise.withResolvers<string | null>();
    settleChannelRead = resolve;
    state.channelsRead = { completion: promise };
    try {
      const res = await client.request<ChannelsStatusSnapshot | null>("channels.status", {
        probe,
        timeoutMs: 8000,
      });
      if (!isCurrent()) {
        return;
      }
      state.channelsSnapshot = res;
      state.channelsError = null;
      state.channelsLastSuccess = Date.now();
    } catch (err) {
      if (!isCurrent()) {
        return;
      }
      if (isMissingOperatorReadScopeError(err)) {
        state.channelsSnapshot = null;
        state.channelsError = formatMissingOperatorReadScopeMessage("channel status");
      } else {
        state.channelsError = formatUiError(err);
      }
    } finally {
      if (isCurrent()) {
        state.channelsLoading = false;
        state.channelsLoadingProbe = null;
        resolve(state.channelsError);
        if (channelsInvalidated) {
          await refreshChannels();
        }
      }
    }
  }
  const refreshChannels = (probe = false): Promise<void> => run(() => loadChannels(probe));
  const runWhatsApp = (task: () => Promise<boolean>): Promise<void> =>
    run(async () => {
      if (await task()) {
        await refreshChannels(true);
      }
    });
  // Gateway changes retire pairing and WhatsApp epochs independently, so pairing scope changes cannot cancel logins.
  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connected = snapshot.phase === "connected";
    const connectionChanged = state.connected !== connected;
    const nextChannelReadAccess = connected
      ? channelSnapshotAllowsScope(snapshot, "operator.read")
      : currentChannelReadAccess;
    const channelReadAccessChanged = currentChannelReadAccess !== nextChannelReadAccess;
    currentChannelReadAccess = nextChannelReadAccess;
    const nextPairingAuthSignature = connected
      ? resolveChannelPairingAuthSignature(snapshot)
      : currentPairingAuthSignature;
    const pairingAuthChanged = currentPairingAuthSignature !== nextPairingAuthSignature;
    currentPairingAuthSignature = nextPairingAuthSignature;
    const nextWhatsAppAdminAccess = connected
      ? channelSnapshotAllowsScope(snapshot, "operator.admin")
      : currentWhatsAppAdminAccess;
    const whatsappAdminAccessChanged = currentWhatsAppAdminAccess !== nextWhatsAppAdminAccess;
    currentWhatsAppAdminAccess = nextWhatsAppAdminAccess;
    state.client = snapshot.client;
    state.connected = connected;
    if (clientChanged || connectionChanged || channelReadAccessChanged) {
      retireChannelRead();
      channelsInvalidated = false;
      state.channelsLoading = false;
      state.channelsLoadingProbe = null;
      state.channelsRefreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
      state.channelsError = connected || !nextChannelReadAccess ? null : state.channelsError;
      if (clientChanged || channelReadAccessChanged) {
        state.channelsSnapshot = null;
        state.channelsLastSuccess = null;
      }
    }
    if (clientChanged || connectionChanged || whatsappAdminAccessChanged) {
      lifecycle.whatsappEpoch += 1;
      state.whatsappBusy = false;
      if (clientChanged || !nextWhatsAppAdminAccess) {
        state.whatsappLoginSessionKey = null;
        state.whatsappLoginMessage = null;
        state.whatsappLoginQrDataUrl = null;
        state.whatsappLoginConnected = null;
      }
    }
    if (clientChanged || connectionChanged || pairingAuthChanged) {
      lifecycle.pairingEpoch += 1;
      if (clientChanged || pairingAuthChanged) {
        state.pairingSnapshot = null;
        state.pairingRead = null;
        state.pairingError = null;
        state.pairingLastSuccess = null;
      }
      invalidatePairingRefresh();
      state.pairingBusyRequestId = null;
    }
    publish();
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (
      event.event !== "config.changed" ||
      !state.connected ||
      !currentChannelReadAccess ||
      (!state.channelsSnapshot && !state.channelsLoading && listeners.size === 0)
    ) {
      return;
    }
    channelsInvalidated = true;
    void refreshChannels();
  });

  return {
    get state() {
      return state;
    },
    refresh: refreshChannels,
    refreshPairing: (): Promise<void> => run(() => loadChannelPairing()),
    approvePairing: async (
      params: Required<Extract<ChannelsPairingApproveParams, { requestId: string }>>,
    ) => {
      const mutation = await run(() =>
        mutateChannelPairing(params.requestId, (client) =>
          client.request<ChannelsPairingApproveResult>("channels.pairing.approve", params),
        ),
      );
      return mutation ? mutation.result : null;
    },
    dismissPairing: async (params: ChannelsPairingDismissParams) =>
      Boolean(
        await run(() =>
          mutateChannelPairing(params.requestId, (client) =>
            client.request("channels.pairing.dismiss", params),
          ),
        ),
      ),
    startWhatsApp: (force: boolean, accountId?: string) =>
      runWhatsApp(() => startWhatsAppLogin(force, accountId)),
    waitWhatsApp: (accountId?: string) => runWhatsApp(() => waitWhatsAppLogin(accountId)),
    logoutWhatsApp: (accountId?: string) => runWhatsApp(() => logoutWhatsApp(accountId)),
    subscribe: (listener: (state: ChannelsState) => void) => registerListener(listeners, listener),
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      retireChannelRead();
      channelsInvalidated = false;
      state.channelsRefreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
      lifecycle.whatsappEpoch += 1;
      lifecycle.pairingEpoch += 1;
      invalidatePairingRefresh();
      state.pairingBusyRequestId = null;
      state.whatsappBusy = false;
      stopGateway();
      stopEvents();
      listeners.clear();
    },
  };
}
