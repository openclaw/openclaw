import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import type { ChannelGatewayClient, ChannelsState } from "./index.ts";

// A QR login lives three minutes, so one wait covers it unless the code rotates.
const WHATSAPP_QR_LOGIN_LIFETIME_MS = 180_000;

/** Owns WhatsApp QR login for the channels capability: start, scan watch, wait and logout. */
export function createWhatsAppLogin(owner: {
  state: ChannelsState;
  /** Gateway changes advance `whatsappEpoch`; `whatsappWatch` retires a passive wait alone. */
  lifecycle: { whatsappEpoch: number; whatsappWatch: number };
  run: <T>(task: () => Promise<T>) => Promise<T | undefined>;
  refreshChannels: (probe?: boolean) => Promise<void>;
  publish: () => void;
}) {
  const { state, lifecycle, run, refreshChannels, publish } = owner;
  const runWhatsApp = (task: () => Promise<boolean>): Promise<void> =>
    run(async () => {
      if (await task()) {
        await refreshChannels(true);
      }
    });

  /** A passive request neither waits for nor blocks other WhatsApp actions; it stays current while `passive` holds. */
  async function runWhatsAppRequest<T>(
    request: (client: ChannelGatewayClient) => Promise<T>,
    onResult: (result: T) => void,
    onError?: () => void,
    passive?: () => boolean,
  ): Promise<boolean> {
    const client = state.client;
    if (!client || !state.connected || (!passive && state.whatsappBusy)) {
      return false;
    }
    if (!passive) {
      state.whatsappBusy = true;
    }
    const whatsappEpoch = lifecycle.whatsappEpoch;
    const isCurrent = () =>
      state.connected &&
      state.client === client &&
      lifecycle.whatsappEpoch === whatsappEpoch &&
      (passive?.() ?? true);
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
      if (!passive && isCurrent()) {
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
        // A shown code speaks for itself; only an outcome without one needs the Gateway's words.
        state.whatsappLoginMessage =
          res.message && !res.qrDataUrl ? formatUiError(res.message) : null;
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

  function waitWhatsAppLogin(accountId?: string, passive?: () => boolean) {
    return runWhatsAppRequest(
      (client) =>
        client.request<{
          message?: string;
          connected?: boolean;
          qrDataUrl?: string;
        }>("web.login.wait", {
          channel: "whatsapp",
          timeoutMs: WHATSAPP_QR_LOGIN_LIFETIME_MS,
          currentQrDataUrl: state.whatsappLoginQrDataUrl ?? undefined,
          ...(state.whatsappLoginSessionKey ? { sessionKey: state.whatsappLoginSessionKey } : {}),
          ...(accountId ? { accountId } : {}),
        }),
      (res) => {
        state.whatsappLoginMessage =
          res.message && (res.connected || !res.qrDataUrl) ? formatUiError(res.message) : null;
        state.whatsappLoginConnected = res.connected ?? null;
        if (res.connected) {
          state.whatsappLoginSessionKey = null;
        }
        // Without a link or a fresh code, the shown code has expired or failed.
        state.whatsappLoginQrDataUrl = res.connected ? null : (res.qrDataUrl ?? null);
      },
      () => {
        state.whatsappLoginConnected = null;
        state.whatsappLoginQrDataUrl = null;
      },
      passive,
    );
  }

  // The phone can be scanned whenever the code shows. Waiting at once lets the Gateway see the
  // link, start the channel and report it here, without a separate wait action. The wait is
  // passive, so Relink and Logout stay usable while the code shows.
  async function watchWhatsAppLogin(accountId?: string): Promise<void> {
    const watch = ++lifecycle.whatsappWatch;
    const watching = () => lifecycle.whatsappWatch === watch;
    // Read through a call: each wait updates the shared state while this loop is suspended.
    const linked = () => state.whatsappLoginConnected === true;
    while (watching() && state.whatsappLoginQrDataUrl && !linked()) {
      if (!(await run(() => waitWhatsAppLogin(accountId, watching)))) {
        return;
      }
      if (watching() && linked()) {
        await refreshChannels(true);
      }
    }
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

  return {
    /** Resolves once a code shows; watching it for a scan continues in the background. */
    async startWhatsApp(force: boolean, accountId?: string) {
      if (!state.whatsappBusy) {
        // A new code replaces the shown one, so its pending wait no longer applies.
        lifecycle.whatsappWatch += 1;
      }
      await runWhatsApp(() => startWhatsAppLogin(force, accountId));
      void watchWhatsAppLogin(accountId);
    },
    waitWhatsApp: (accountId?: string) => runWhatsApp(() => waitWhatsAppLogin(accountId)),
    /** Stops watching the shown code; a scan the Gateway is already waiting on still links. */
    stopWhatsAppLogin() {
      lifecycle.whatsappEpoch += 1;
      lifecycle.whatsappWatch += 1;
      state.whatsappBusy = false;
      state.whatsappLoginSessionKey = null;
      state.whatsappLoginMessage = null;
      state.whatsappLoginQrDataUrl = null;
      state.whatsappLoginConnected = null;
      publish();
    },
    async logoutWhatsApp(accountId?: string) {
      if (state.whatsappBusy) {
        return;
      }
      // A logout ends the pending wait; a code that is still shown afterwards is watched again.
      lifecycle.whatsappWatch += 1;
      await runWhatsApp(() => logoutWhatsApp(accountId));
      void watchWhatsAppLogin(accountId);
    },
  };
}
