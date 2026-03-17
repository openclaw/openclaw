import { ChannelsStatusSnapshot } from "../types.ts";
import type { ChannelsState } from "./channels.types.ts";

export type { ChannelsState };

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
}

async function refreshActiveWhatsAppQr(state: ChannelsState) {
  if (!state.client || !state.connected) {
    return;
  }
  const res = await state.client.request<{ message?: string; qrDataUrl?: string }>(
    "web.login.start",
    {
      force: false,
      timeoutMs: 5000,
    },
  );
  if (res.qrDataUrl) {
    state.whatsappLoginQrDataUrl = res.qrDataUrl;
  }
  if (res.message) {
    state.whatsappLoginMessage = res.message;
  }
}

export async function waitWhatsAppLogin(
  state: ChannelsState,
  opts: { timeoutMs?: number; pollMs?: number } = {},
) {
  if (!state.client || !state.connected || state.whatsappBusy) {
    return;
  }
  state.whatsappBusy = true;
  try {
    const deadline = Date.now() + Math.max(opts.timeoutMs ?? 120_000, 1_000);
    const pollMs = Math.max(opts.pollMs ?? 5_000, 1_000);
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      const res = await state.client.request<{ message?: string; connected?: boolean }>(
        "web.login.wait",
        {
          timeoutMs: Math.min(remaining, pollMs),
        },
      );
      state.whatsappLoginMessage = res.message ?? null;
      state.whatsappLoginConnected = res.connected ?? null;
      if (res.connected) {
        state.whatsappLoginQrDataUrl = null;
        break;
      }
      try {
        await refreshActiveWhatsAppQr(state);
      } catch {
        // Best-effort: a transient refresh failure should not abort login polling.
      }
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
