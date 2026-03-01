import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

const probeCache = new Map<string, { result: FeishuProbeResult; expiresAt: number }>();
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PROBE_CACHE_SIZE = 64;

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }

  const cacheKey = creds.accountId ?? `${creds.appId}:${creds.appSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const client = createFeishuClient(creds);
    // Lark SDK Client exposes `.request()` at runtime but the type definitions
    // do not declare it publicly; cast to bypass the missing declaration.
    const response = await (client as { request: (opts: unknown) => Promise<unknown> }).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    const res = response as {
      code?: number;
      msg?: string;
      bot?: unknown;
      data?: { bot?: unknown };
    };
    if (res.code !== 0) {
      return {
        ok: false,
        appId: creds.appId,
        error: `API error: ${res.msg || `code ${res.code}`}`,
      };
    }

    const bot = (res.bot || res.data?.bot) as { bot_name?: string; open_id?: string } | undefined;
    const result: FeishuProbeResult = {
      ok: true,
      appId: creds.appId,
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    };

    probeCache.set(cacheKey, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
    if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
      const oldest = probeCache.keys().next().value;
      if (oldest !== undefined) {
        probeCache.delete(oldest);
      }
    }

    return result;
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function clearProbeCache(): void {
  probeCache.clear();
}
