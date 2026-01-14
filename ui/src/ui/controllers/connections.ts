import { parseList } from "../format";
import type { ChannelsStatusSnapshot } from "../types";
import {
  type DiscordForm,
  type IMessageForm,
  type SlackForm,
  type SignalForm,
  type TelegramForm,
} from "../ui-types";
import type { ConnectionsState } from "./connections.types";

export { saveDiscordConfig } from "./connections.save-discord";
export { saveIMessageConfig } from "./connections.save-imessage";
export { saveSlackConfig } from "./connections.save-slack";
export { saveSignalConfig } from "./connections.save-signal";

export type { ConnectionsState };

export async function loadChannels(state: ConnectionsState, probe: boolean) {
  if (!state.client || !state.connected) return;
  if (state.channelsLoading) return;
  state.channelsLoading = true;
  state.channelsError = null;
  try {
    const res = (await state.client.request("channels.status", {
      probe,
      timeoutMs: 8000,
    })) as ChannelsStatusSnapshot;
    state.channelsSnapshot = res;
    state.channelsLastSuccess = Date.now();
    const channels = res.channels as Record<string, unknown>;
    const telegram = channels.telegram as { tokenSource?: string | null };
    const discord = channels.discord as { tokenSource?: string | null } | null;
    const slack = channels.slack as
      | { botTokenSource?: string | null; appTokenSource?: string | null }
      | null;
    state.telegramTokenLocked = telegram?.tokenSource === "env";
    state.discordTokenLocked = discord?.tokenSource === "env";
    state.slackTokenLocked = slack?.botTokenSource === "env";
    state.slackAppTokenLocked = slack?.appTokenSource === "env";
  } catch (err) {
    state.channelsError = String(err);
  } finally {
    state.channelsLoading = false;
  }
}

export async function startWhatsAppLogin(state: ConnectionsState, force: boolean) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    const res = (await state.client.request("web.login.start", {
      force,
      timeoutMs: 30000,
    })) as { message?: string; qrDataUrl?: string };
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

export async function waitWhatsAppLogin(state: ConnectionsState) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
  state.whatsappBusy = true;
  try {
    const res = (await state.client.request("web.login.wait", {
      timeoutMs: 120000,
    })) as { connected?: boolean; message?: string };
    state.whatsappLoginMessage = res.message ?? null;
    state.whatsappLoginConnected = res.connected ?? null;
    if (res.connected) state.whatsappLoginQrDataUrl = null;
  } catch (err) {
    state.whatsappLoginMessage = String(err);
    state.whatsappLoginConnected = null;
  } finally {
    state.whatsappBusy = false;
  }
}

export async function logoutWhatsApp(state: ConnectionsState) {
  if (!state.client || !state.connected || state.whatsappBusy) return;
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

export function updateTelegramForm(
  state: ConnectionsState,
  patch: Partial<TelegramForm>,
) {
  state.telegramForm = { ...state.telegramForm, ...patch };
}

export function updateDiscordForm(
  state: ConnectionsState,
  patch: Partial<DiscordForm>,
) {
  if (patch.actions) {
    state.discordForm = {
      ...state.discordForm,
      ...patch,
      actions: { ...state.discordForm.actions, ...patch.actions },
    };
    return;
  }
  state.discordForm = { ...state.discordForm, ...patch };
}

export function updateSlackForm(
  state: ConnectionsState,
  patch: Partial<SlackForm>,
) {
  if (patch.actions) {
    state.slackForm = {
      ...state.slackForm,
      ...patch,
      actions: { ...state.slackForm.actions, ...patch.actions },
    };
    return;
  }
  state.slackForm = { ...state.slackForm, ...patch };
}

export function updateSignalForm(
  state: ConnectionsState,
  patch: Partial<SignalForm>,
) {
  state.signalForm = { ...state.signalForm, ...patch };
}

export function updateIMessageForm(
  state: ConnectionsState,
  patch: Partial<IMessageForm>,
) {
  state.imessageForm = { ...state.imessageForm, ...patch };
}

export async function saveTelegramConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.telegramSaving) return;
  state.telegramSaving = true;
  state.telegramConfigStatus = null;
  try {
    if (state.telegramForm.groupsWildcardEnabled) {
      const confirmed = window.confirm(
        'Telegram groups wildcard "*" allows all groups. Continue?',
      );
      if (!confirmed) {
        state.telegramConfigStatus = "Save cancelled.";
        return;
      }
    }
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const telegram = { ...(config.telegram ?? {}) } as Record<string, unknown>;
    if (!state.telegramTokenLocked) {
      const token = state.telegramForm.token.trim();
      if (token) telegram.botToken = token;
      else delete telegram.botToken;
    }
    const groups =
      telegram.groups && typeof telegram.groups === "object"
        ? ({ ...(telegram.groups as Record<string, unknown>) } as Record<
            string,
            unknown
          >)
        : {};
    if (state.telegramForm.groupsWildcardEnabled) {
      const defaultGroup =
        groups["*"] && typeof groups["*"] === "object"
          ? ({ ...(groups["*"] as Record<string, unknown>) } as Record<
              string,
              unknown
            >)
          : {};
      defaultGroup.requireMention = state.telegramForm.requireMention;
      groups["*"] = defaultGroup;
      telegram.groups = groups;
    } else if (groups["*"]) {
      delete groups["*"];
      if (Object.keys(groups).length > 0) telegram.groups = groups;
      else delete telegram.groups;
    }
    delete telegram.requireMention;
    const allowFrom = parseList(state.telegramForm.allowFrom);
    if (allowFrom.length > 0) telegram.allowFrom = allowFrom;
    else delete telegram.allowFrom;
    const proxy = state.telegramForm.proxy.trim();
    if (proxy) telegram.proxy = proxy;
    else delete telegram.proxy;
    const webhookUrl = state.telegramForm.webhookUrl.trim();
    if (webhookUrl) telegram.webhookUrl = webhookUrl;
    else delete telegram.webhookUrl;
    const webhookSecret = state.telegramForm.webhookSecret.trim();
    if (webhookSecret) telegram.webhookSecret = webhookSecret;
    else delete telegram.webhookSecret;
    const webhookPath = state.telegramForm.webhookPath.trim();
    if (webhookPath) telegram.webhookPath = webhookPath;
    else delete telegram.webhookPath;

    config.telegram = telegram;
    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.telegramConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.telegramConfigStatus = String(err);
  } finally {
    state.telegramSaving = false;
  }
}
