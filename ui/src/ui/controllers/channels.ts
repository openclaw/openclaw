import { ChannelsStatusSnapshot } from "../types.ts";
import type { ChannelsState } from "./channels.types.ts";

export type { ChannelsState };

/**
 * Generation counter for QR poll loops.
 * Incrementing this cancels any in-flight poll iteration.
 */
let qrPollGeneration = 0;

export async function loadChannels(state: ChannelsState, probe: boolean) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.channelsLoading) {
    return;
  }
  state.channelsLoading = true;
  state.channelsError = null;
  try {
    const res = await state.client.request<ChannelsStatusSnapshot | null>("channels.status", {
      probe,
      timeoutMs: 8000,
    });
    state.channelsSnapshot = res;
    state.channelsLastSuccess = Date.now();
  } catch (err) {
    state.channelsError = String(err);
  } finally {
    state.channelsLoading = false;
  }
}

export async function startWhatsAppLogin(state: ChannelsState, force: boolean) {
  stopWhatsAppQrPoll();
  if (!state.client || !state.connected || state.whatsappBusy) {
    return;
  }
  state.whatsappBusy = true;
  try {
    const res = await state.client.request<{ message?: string; qrDataUrl?: string }>(
      "web.login.start",
      {
        force,
        timeoutMs: 30000,
      },
    );
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginQrDataUrl = res.qrDataUrl ?? null;
    state.whatsappLoginConnected = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
  // Auto-start polling for QR refresh + connection detection.
  if (state.whatsappLoginQrDataUrl && state.client && state.connected) {
    startWhatsAppQrPoll(state);
  }
}

/**
 * Poll `web.login.wait` in a loop with short timeouts.
 * Each iteration returns the latest QR data URL (which may have
 * rotated server-side) and connection status.
 * The loop stops when the session connects, errors out, or is cancelled.
 */
export function startWhatsAppQrPoll(state: ChannelsState) {
  stopWhatsAppQrPoll();
  const myGeneration = ++qrPollGeneration;
  void (async () => {
    while (
      myGeneration === qrPollGeneration &&
      state.client &&
      state.connected &&
      state.whatsappLoginQrDataUrl
    ) {
      try {
        const res = await state.client.request<{
          connected?: boolean;
          message?: string;
          qrDataUrl?: string;
        }>("web.login.wait", {
          timeoutMs: 15000,
        });
        if (myGeneration !== qrPollGeneration) {
          break;
        }
        state.whatsappLoginMessage = res.message ?? null;
        if (res.qrDataUrl) {
          state.whatsappLoginQrDataUrl = res.qrDataUrl;
        }
        if (res.connected) {
          state.whatsappLoginConnected = true;
          state.whatsappLoginQrDataUrl = null;
          // Refresh channel status now that WhatsApp is linked.
          void loadChannels(state, true);
          break;
        }
        // Server returned a terminal non-connected response with no QR
        // refresh (e.g. login TTL expired, session reset). Clear the
        // stale QR and stop polling to avoid an infinite loop.
        if (!res.qrDataUrl) {
          state.whatsappLoginQrDataUrl = null;
          break;
        }
      } catch (err) {
        if (myGeneration !== qrPollGeneration) {
          break;
        }
        state.whatsappLoginMessage = String(err);
        state.whatsappLoginConnected = null;
        break;
      }
    }
  })();
}

/** Cancel any in-flight QR poll loop. */
export function stopWhatsAppQrPoll() {
  qrPollGeneration++;
}

export async function waitWhatsAppLogin(state: ChannelsState) {
  if (!state.client || !state.connected || state.whatsappBusy) {
    return;
  }
  // If a QR is displayed, just (re)start the poll loop; no need to block the UI.
  if (state.whatsappLoginQrDataUrl) {
    startWhatsAppQrPoll(state);
    return;
  }
  state.whatsappBusy = true;
  try {
    const res = await state.client.request<{
      message?: string;
      connected?: boolean;
      qrDataUrl?: string;
    }>("web.login.wait", {
      timeoutMs: 120000,
    });
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginConnected = res.connected ?? null;
    if (res.qrDataUrl) {
      state.whatsappLoginQrDataUrl = res.qrDataUrl;
    }
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
  stopWhatsAppQrPoll();
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
