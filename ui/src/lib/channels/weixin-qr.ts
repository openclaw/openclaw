import { t } from "../../i18n/index.ts";
import { registerWeixinEnglish } from "../../i18n/locales/en-weixin.ts";
import { formatUiError } from "../format-error.ts";
import { initialWeixinQrState, type WeixinQrState } from "./weixin-qr-state.ts";

registerWeixinEnglish();

/** Only render bounded embedded PNGs; provider URLs and raw QR contents are never image sources. */
export function isWeixinQrImage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256_000 &&
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}
type Client = { request<T = unknown>(method: string, params?: unknown): Promise<T> };
type LoginResult = {
  connected?: boolean;
  cancelled?: boolean;
  verificationRequired?: boolean;
  qrDataUrl?: string;
  sessionKey?: string;
  expiresAtMs?: number;
  message?: string;
};

/** Composed into the Channels capability, which owns connection and authorization invalidation. */
export function createWeixinQrController(options: {
  getClient: () => Client | null;
  setState: (state: WeixinQrState) => void;
  refresh: () => Promise<void>;
}) {
  let state = initialWeixinQrState();
  let epoch = 0;
  let owner: Client | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = (patch: Partial<WeixinQrState>) => {
    state = { ...state, ...patch };
    options.setState(state);
  };
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const clearExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
  };
  const current = (client: Client, generation: number) =>
    epoch === generation && owner === client && options.getClient() === client;
  const cancelRemote = async (client: Client, sessionKey: string) => {
    await client.request("weixin.login.control", { action: "cancel", sessionKey });
  };
  function invalidate() {
    const client = owner;
    const sessionKey = state.sessionKey;
    epoch++;
    clearTimer();
    clearExpiry();
    owner = null;
    state = initialWeixinQrState();
    options.setState(state);
    if (client && sessionKey) {
      void cancelRemote(client, sessionKey).catch(() => {});
    }
  }
  async function poll(client: Client, generation: number) {
    if (!current(client, generation) || !state.sessionKey || state.busy) {
      return;
    }
    publish({ busy: true });
    try {
      const result = await client.request<LoginResult>("web.login.wait", {
        channel: "openclaw-weixin",
        sessionKey: state.sessionKey,
        preserveRunning: true,
        timeoutMs: 10_000,
      });
      if (!current(client, generation)) {
        return;
      }
      await accept(result, client, generation, true);
    } catch (error) {
      if (current(client, generation)) {
        fail(error);
      }
    } finally {
      if (current(client, generation)) {
        publish({ busy: false });
        schedule(client, generation);
      }
    }
  }
  function schedule(client: Client, generation: number) {
    clearTimer();
    if (state.phase !== "waiting") {
      return;
    }
    timer = setTimeout(() => {
      void poll(client, generation);
    }, 1_000);
  }
  function fail(error: unknown) {
    clearTimer();
    clearExpiry();
    const client = owner;
    const sessionKey = state.sessionKey;
    publish({
      phase: "error",
      qrDataUrl: null,
      sessionKey: null,
      expiresAtMs: null,
      busy: false,
      message: formatUiError(error),
    });
    if (client && sessionKey) {
      void cancelRemote(client, sessionKey).catch(() => {});
    }
  }
  async function accept(result: LoginResult, client: Client, generation: number, waiting = false) {
    if (result.sessionKey && state.sessionKey && result.sessionKey !== state.sessionKey) {
      throw new Error(t("channels.weixin.sessionChanged"));
    }
    if (result.cancelled) {
      invalidate();
      return;
    }
    if (result.connected) {
      clearExpiry();
      publish({
        phase: "connected",
        qrDataUrl: null,
        expiresAtMs: null,
        sessionKey: null,
        message: result.message ?? null,
      });
      await options.refresh();
      return;
    }
    // A verification challenge may omit the unchanged QR. Only a current wait
    // can reuse its still-live presentation; terminal failures never revive it.
    const retainChallenge =
      waiting &&
      result.verificationRequired === true &&
      current(client, generation) &&
      state.expiresAtMs !== null &&
      state.expiresAtMs > Date.now();
    const sessionKey = result.sessionKey ?? (retainChallenge ? state.sessionKey : undefined);
    const qrDataUrl = result.qrDataUrl ?? (retainChallenge ? state.qrDataUrl : undefined);
    const expiresAtMs = result.expiresAtMs ?? (retainChallenge ? state.expiresAtMs : undefined);
    if (sessionKey) {
      publish({ sessionKey });
    }
    if (!sessionKey || !qrDataUrl) {
      throw new Error(result.message || t("channels.weixin.pendingMissing"));
    }
    if (
      !isWeixinQrImage(qrDataUrl) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs! > Date.now() + 300_000 ||
      expiresAtMs! < 0
    ) {
      throw new Error(t("channels.weixin.unsupported"));
    }
    publish({
      sessionKey,
      qrDataUrl,
      expiresAtMs,
      phase: result.verificationRequired ? "verification" : "waiting",
      message: result.message ?? null,
    });
    clearExpiry();
    expiryTimer = setTimeout(
      () => {
        if (current(client, generation) && state.phase !== "connected") {
          publish({
            qrDataUrl: null,
            phase: "expired",
          });
        }
      },
      Math.min(300_000, Math.max(0, expiresAtMs! - Date.now())),
    );
    if (!current(client, generation)) {
      return;
    }
    if (expiresAtMs! <= Date.now()) {
      publish({ phase: "expired", qrDataUrl: null });
    }
  }
  return {
    invalidate,
    async start() {
      invalidate();
      const client = options.getClient();
      if (!client) {
        return;
      }
      owner = client;
      const generation = epoch;
      publish({ phase: "starting", busy: true });
      try {
        // Probe the plugin before core QR takeover can stop an existing account.
        const support = await client
          .request<{ supportsPageLogin?: boolean; message?: string }>("weixin.login.control", {
            action: "capabilities",
          })
          .catch((error: unknown) => {
            if (formatUiError(error).toLowerCase().includes("unknown method:")) {
              throw new Error(t("channels.weixin.unsupported"));
            }
            throw error;
          });
        if (!current(client, generation)) {
          return;
        }
        if (support.supportsPageLogin !== true) {
          throw new Error(
            typeof support.message === "string" && support.message.trim()
              ? support.message
              : t("channels.weixin.unsupported"),
          );
        }
        const result = await client.request<LoginResult>("web.login.start", {
          channel: "openclaw-weixin",
          force: false,
          preserveRunning: true,
          timeoutMs: 30_000,
        });
        if (!current(client, generation)) {
          if (result.sessionKey) {
            await cancelRemote(client, result.sessionKey).catch(() => {});
          }
          return;
        }
        await accept(result, client, generation);
      } catch (error) {
        if (current(client, generation)) {
          fail(error);
        }
      } finally {
        if (current(client, generation)) {
          publish({ busy: false });
          schedule(client, generation);
        }
      }
    },
    async verify(code: string) {
      const client = owner;
      const sessionKey = state.sessionKey;
      const generation = epoch;
      if (
        !client ||
        !sessionKey ||
        state.phase !== "verification" ||
        state.busy ||
        !/^\d{1,10}$/.test(code.trim()) ||
        !current(client, generation)
      ) {
        return;
      }
      publish({ busy: true });
      try {
        await client.request("weixin.login.control", {
          action: "verify",
          sessionKey,
          code: code.trim(),
        });
        if (current(client, generation)) {
          publish({ phase: "waiting" });
        }
      } catch (error) {
        if (current(client, generation)) {
          fail(error);
        }
      } finally {
        if (current(client, generation)) {
          publish({ busy: false });
          schedule(client, generation);
        }
      }
    },
    async close() {
      const client = owner;
      const sessionKey = state.sessionKey;
      epoch++;
      const generation = epoch;
      clearTimer();
      clearExpiry();
      owner = null;
      state = initialWeixinQrState();
      options.setState(state);
      if (client && sessionKey) {
        try {
          await cancelRemote(client, sessionKey);
        } catch (error) {
          if (epoch === generation && !owner && state.phase === "idle") {
            fail(error);
          }
        }
      }
    },
  };
}
