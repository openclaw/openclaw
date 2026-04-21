import { ChannelsStatusSnapshot } from "../types.ts";
import { GatewayRequestError } from "../gateway.ts";
import type { ChannelsState } from "./channels.types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type { ChannelsState };

type ChannelsRequestStrength = {
  probe: boolean;
  includeAccounts: boolean;
};

type ChannelsPrivateState = ChannelsState & {
  __channelsRequestSeq?: number;
  __channelsInFlight?: (ChannelsRequestStrength & { seq: number }) | null;
  __channelsPending?: ChannelsRequestStrength | null;
};

function normalizeChannelsRequestStrength(params: {
  probe: boolean;
  includeAccounts?: boolean;
}): ChannelsRequestStrength {
  return {
    probe: params.probe,
    includeAccounts: params.includeAccounts !== false,
  };
}

function mergeChannelsRequestStrength(
  current: ChannelsRequestStrength | null | undefined,
  next: ChannelsRequestStrength,
): ChannelsRequestStrength {
  if (!current) {
    return next;
  }
  return {
    probe: current.probe || next.probe,
    includeAccounts: current.includeAccounts || next.includeAccounts,
  };
}

function isStrongerChannelsRequest(
  candidate: ChannelsRequestStrength | null | undefined,
  current: ChannelsRequestStrength | null | undefined,
): boolean {
  if (!candidate) {
    return false;
  }
  if (!current) {
    return true;
  }
  return (
    (candidate.includeAccounts && !current.includeAccounts) || (candidate.probe && !current.probe)
  );
}

function buildChannelsStatusRequestParams(request: ChannelsRequestStrength): Record<string, unknown> {
  return {
    probe: request.probe,
    ...(request.includeAccounts ? {} : { includeAccounts: false }),
    timeoutMs: 8000,
  };
}

function buildLegacyChannelsStatusRequestParams(request: ChannelsRequestStrength): Record<string, unknown> {
  return {
    probe: request.probe,
    timeoutMs: 8000,
  };
}

function isUnsupportedIncludeAccountsRequestError(err: unknown): boolean {
  return (
    err instanceof GatewayRequestError &&
    err.gatewayCode === "INVALID_REQUEST" &&
    /includeaccounts|additional properties/i.test(err.message)
  );
}

async function requestChannelsStatus(
  state: ChannelsState,
  request: ChannelsRequestStrength,
): Promise<ChannelsStatusSnapshot | null> {
  const client = state.client;
  if (!client) {
    return null;
  }
  try {
    return await client.request<ChannelsStatusSnapshot | null>(
      "channels.status",
      buildChannelsStatusRequestParams(request),
    );
  } catch (err) {
    if (request.includeAccounts || !isUnsupportedIncludeAccountsRequestError(err)) {
      throw err;
    }
    return await client.request<ChannelsStatusSnapshot | null>(
      "channels.status",
      buildLegacyChannelsStatusRequestParams(request),
    );
  }
}

export async function loadChannels(
  state: ChannelsState,
  probe: boolean,
  opts?: { includeAccounts?: boolean },
) {
  const privateState = state as ChannelsPrivateState;
  const request = normalizeChannelsRequestStrength({
    probe,
    includeAccounts: opts?.includeAccounts,
  });
  if (!state.client || !state.connected) {
    return;
  }
  if (state.channelsLoading) {
    if (isStrongerChannelsRequest(request, privateState.__channelsInFlight)) {
      privateState.__channelsPending = mergeChannelsRequestStrength(
        privateState.__channelsPending,
        request,
      );
    }
    return;
  }
  const seq = (privateState.__channelsRequestSeq ?? 0) + 1;
  privateState.__channelsRequestSeq = seq;
  privateState.__channelsInFlight = { ...request, seq };
  state.channelsLoading = true;
  state.channelsError = null;
  try {
    const res = await requestChannelsStatus(state, request);
    const pendingStronger = isStrongerChannelsRequest(privateState.__channelsPending, request);
    if (privateState.__channelsRequestSeq === seq && !pendingStronger) {
      state.channelsSnapshot = res;
      state.channelsLastSuccess = Date.now();
    }
  } catch (err) {
    const pendingStronger = isStrongerChannelsRequest(privateState.__channelsPending, request);
    if (privateState.__channelsRequestSeq === seq && !pendingStronger) {
      if (isMissingOperatorReadScopeError(err)) {
        state.channelsSnapshot = null;
        state.channelsError = formatMissingOperatorReadScopeMessage("channel status");
      } else {
        state.channelsError = String(err);
      }
    }
  } finally {
    if (privateState.__channelsInFlight?.seq === seq) {
      privateState.__channelsInFlight = null;
      state.channelsLoading = false;
    }
    const pending = privateState.__channelsPending;
    if (
      pending &&
      privateState.__channelsRequestSeq === seq &&
      !privateState.__channelsInFlight &&
      state.connected &&
      state.client
    ) {
      privateState.__channelsPending = null;
      void loadChannels(state, pending.probe, {
        includeAccounts: pending.includeAccounts,
      });
    }
  }
}

export async function startWhatsAppLogin(state: ChannelsState, force: boolean) {
  if (!state.client || !state.connected || state.whatsappBusy) {
    return;
  }
  state.whatsappBusy = true;
  try {
    const res = await state.client.request<{
      message?: string;
      qrDataUrl?: string;
      connected?: boolean;
    }>("web.login.start", {
      force,
      timeoutMs: 30000,
    });
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginQrDataUrl = res.qrDataUrl ?? null;
    state.whatsappLoginConnected = typeof res.connected === "boolean" ? res.connected : null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
}

export async function waitWhatsAppLogin(state: ChannelsState) {
  if (!state.client || !state.connected || state.whatsappBusy) {
    return;
  }
  state.whatsappBusy = true;
  try {
    const res = await state.client.request<{ message?: string; connected?: boolean }>(
      "web.login.wait",
      {
        timeoutMs: 120000,
      },
    );
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginConnected = res.connected ?? null;
    if (res.connected) {
      state.whatsappLoginQrDataUrl = null;
    }
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
}

export async function logoutWhatsApp(state: ChannelsState) {
  if (!state.client || !state.connected || state.whatsappBusy) {
    return;
  }
  state.whatsappBusy = true;
  try {
    await state.client.request("channels.logout", { channel: "whatsapp" });
    state.whatsappLoginMessage = "Logged out.";
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
  } finally {
    state.whatsappBusy = false;
  }
}
