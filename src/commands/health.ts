import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { makeProxyFetch } from "../telegram/proxy.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";
import {
  createWaSocket,
  getStatusCode,
  getWebAuthAgeMs,
  logWebSelfId,
  waitForWaConnection,
  webAuthExists,
} from "../web/session.js";

type HealthConnect = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
};

type TelegramProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  bot?: { id?: number | null; username?: string | null };
  webhook?: { url?: string | null; hasCustomCert?: boolean | null };
};

export type HealthSummary = {
  ts: number;
  durationMs: number;
  web: {
    linked: boolean;
    authAgeMs: number | null;
    connect?: HealthConnect;
  };
  telegram: {
    configured: boolean;
    probe?: TelegramProbe;
  };
  heartbeatSeconds: number;
  sessions: {
    path: string;
    count: number;
    recent: Array<{
      key: string;
      updatedAt: number | null;
      age: number | null;
    }>;
  };
};

const DEFAULT_TIMEOUT_MS = 10_000;
const TELEGRAM_API_BASE = "https://api.telegram.org";

async function probeWebConnect(timeoutMs: number): Promise<HealthConnect> {
  const started = Date.now();
  const sock = await createWaSocket(false, false);
  try {
    await Promise.race([
      waitForWaConnection(sock),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    return {
      ok: true,
      status: null,
      error: null,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const status = getStatusCode(err);
    // Conflict/duplicate sessions are expected when the primary gateway session
    // is already connected. Treat these as healthy so health checks don’t flap.
    if (status === 409 || status === 515) {
      return {
        ok: true,
        status,
        error: "already connected (conflict)",
        elapsedMs: Date.now() - started,
      };
    }
    return {
      ok: false,
      status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  } finally {
    try {
      sock.ws?.close();
    } catch {
      // ignore
    }
  }
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeTelegram(
  token: string,
  timeoutMs: number,
  proxyUrl?: string,
): Promise<TelegramProbe> {
  const started = Date.now();
  const fetcher = proxyUrl ? makeProxyFetch(proxyUrl) : fetch;
  const base = `${TELEGRAM_API_BASE}/bot${token}`;

  const result: TelegramProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };

  try {
    const meRes = await fetchWithTimeout(`${base}/getMe`, timeoutMs, fetcher);
    const meJson = (await meRes.json()) as {
      ok?: boolean;
      description?: string;
      result?: { id?: number; username?: string };
    };
    if (!meRes.ok || !meJson?.ok) {
      result.status = meRes.status;
      result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }

    result.bot = {
      id: meJson.result?.id ?? null,
      username: meJson.result?.username ?? null,
    };

    // Try to fetch webhook info, but don't fail health if it errors
    try {
      const webhookRes = await fetchWithTimeout(
        `${base}/getWebhookInfo`,
        timeoutMs,
        fetcher,
      );
      const webhookJson = (await webhookRes.json()) as {
        ok?: boolean;
        result?: {
          url?: string;
          has_custom_certificate?: boolean;
        };
      };
      if (webhookRes.ok && webhookJson?.ok) {
        result.webhook = {
          url: webhookJson.result?.url ?? null,
          hasCustomCert: webhookJson.result?.has_custom_certificate ?? null,
        };
      }
    } catch {
      // ignore webhook errors for health
    }

    result.ok = true;
    result.status = null;
    result.error = null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}

export async function getHealthSnapshot(
  timeoutMs?: number,
  opts?: { probe?: boolean },
): Promise<HealthSummary> {
  const cfg = loadConfig();
  const linked = await webAuthExists();
  const authAgeMs = getWebAuthAgeMs();
  const heartbeatSeconds = resolveHeartbeatSeconds(cfg, undefined);
  const storePath = resolveStorePath(cfg.inbound?.reply?.session?.store);
  const store = loadSessionStore(storePath);
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({ key, updatedAt: entry?.updatedAt ?? 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = sessions.slice(0, 5).map((s) => ({
    key: s.key,
    updatedAt: s.updatedAt || null,
    age: s.updatedAt ? Date.now() - s.updatedAt : null,
  }));

  const start = Date.now();
  const cappedTimeout = Math.max(1000, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const connect =
    linked && opts?.probe ? await probeWebConnect(cappedTimeout) : undefined;

  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN ?? cfg.telegram?.botToken ?? "";
  const telegramConfigured = telegramToken.trim().length > 0;
  const telegramProxy = cfg.telegram?.proxy;
  const telegramProbe = telegramConfigured
    ? await probeTelegram(telegramToken.trim(), cappedTimeout, telegramProxy)
    : undefined;

  const summary: HealthSummary = {
    ts: Date.now(),
    durationMs: Date.now() - start,
    web: { linked, authAgeMs, connect },
    telegram: { configured: telegramConfigured, probe: telegramProbe },
    heartbeatSeconds,
    sessions: {
      path: storePath,
      count: sessions.length,
      recent,
    },
  };

  return summary;
}

export async function healthCommand(
  opts: { json?: boolean; timeoutMs?: number; probe?: boolean },
  runtime: RuntimeEnv,
) {
  const probe = opts.probe ?? true;
  const summary = await getHealthSnapshot(opts.timeoutMs, {
    probe,
  });
  const fatal =
    !summary.web.linked ||
    (summary.web.connect && !summary.web.connect.ok) ||
    (summary.telegram.configured &&
      summary.telegram.probe &&
      !summary.telegram.probe.ok);

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
  } else {
    runtime.log(
      summary.web.linked
        ? `Web: linked (auth age ${summary.web.authAgeMs ? `${Math.round(summary.web.authAgeMs / 60000)}m` : "unknown"})`
        : "Web: not linked (run clawdis login)",
    );
    if (summary.web.linked) {
      logWebSelfId(runtime, true);
    }
    if (summary.web.connect) {
      const base = summary.web.connect.ok
        ? info(`Connect: ok (${summary.web.connect.elapsedMs}ms)`)
        : `Connect: failed (${summary.web.connect.status ?? "unknown"})`;
      runtime.log(
        base +
          (summary.web.connect.error ? ` - ${summary.web.connect.error}` : ""),
      );
    }

    const tgLabel = summary.telegram.configured
      ? summary.telegram.probe?.ok
        ? info(
            `Telegram: ok${summary.telegram.probe.bot?.username ? ` (@${summary.telegram.probe.bot.username})` : ""} (${summary.telegram.probe.elapsedMs}ms)` +
              (summary.telegram.probe.webhook?.url
                ? ` - webhook ${summary.telegram.probe.webhook.url}`
                : ""),
          )
        : `Telegram: failed (${summary.telegram.probe?.status ?? "unknown"})${summary.telegram.probe?.error ? ` - ${summary.telegram.probe.error}` : ""}`
      : "Telegram: not configured";
    runtime.log(tgLabel);

    runtime.log(info(`Heartbeat interval: ${summary.heartbeatSeconds}s`));
    runtime.log(
      info(
        `Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`,
      ),
    );
    if (summary.sessions.recent.length > 0) {
      runtime.log("Recent sessions:");
      for (const r of summary.sessions.recent) {
        runtime.log(
          `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60000)}m ago` : "no activity"})`,
        );
      }
    }
  }

  if (fatal) {
    runtime.exit(1);
  }
}
