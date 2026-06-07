// Best-effort HUD mirroring for realtime Talk final delivery state.
import { normalizeTalkSection } from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const TALK_FINAL_HUD_TIMEOUT_MS = 1_500;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export type TalkFinalHudMirrorStatus = "speaking" | "degraded";

export type TalkFinalHudMirrorParams = {
  cfg?: OpenClawConfig;
  text: string;
  status: TalkFinalHudMirrorStatus;
  detail?: string;
  source?: string;
  sessionId: string;
  runId?: string;
  callId?: string;
  provider?: string;
};

type TalkFinalHudMirrorConfig = NonNullable<
  NonNullable<ReturnType<typeof normalizeTalkSection>>["realtime"]
>["finalHud"];

function resolveTalkFinalHudConfig(cfg?: OpenClawConfig): TalkFinalHudMirrorConfig | undefined {
  const finalHud = normalizeTalkSection(cfg?.talk)?.realtime?.finalHud;
  if (finalHud?.enabled !== true) {
    return undefined;
  }
  return finalHud;
}

function resolveLoopbackHudBaseUrl(rawBaseUrl: string | undefined): string | undefined {
  if (!rawBaseUrl?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(rawBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

async function postHudJson(baseUrl: string, path: string, payload: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TALK_FINAL_HUD_TIMEOUT_MS);
  try {
    await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

export async function mirrorTalkFinalHud(params: TalkFinalHudMirrorParams): Promise<void> {
  const config = resolveTalkFinalHudConfig(params.cfg);
  const baseUrl = resolveLoopbackHudBaseUrl(config?.baseUrl);
  const text = params.text.trim();
  const streamText = text || params.detail?.trim();
  if (!config || !baseUrl || !streamText) {
    return;
  }
  const channel = config.streamChannel ?? "voice";
  const degraded = params.status === "degraded";
  const monitorKind = config.monitorKind ?? "talk";
  await Promise.allSettled([
    postHudJson(baseUrl, "/api/stream", {
      text: streamText,
      channel,
      level: degraded ? "warn" : "info",
    }),
    postHudJson(baseUrl, "/api/pulse", {
      source: "voice",
      intensity: degraded ? 0.85 : 0.55,
      label: degraded ? "voice degraded" : "voice final",
    }),
    postHudJson(baseUrl, "/api/monitor/report", {
      kind: monitorKind,
      entries: [
        {
          id: "realtime-final-voice",
          label: "Realtime voice final",
          status: params.status,
          detail: params.detail ?? params.source ?? "",
          sessionId: params.sessionId,
          runId: params.runId ?? "",
          callId: params.callId ?? "",
          provider: params.provider ?? "",
        },
      ],
    }),
  ]);
}
