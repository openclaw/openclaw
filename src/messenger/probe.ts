import { GRAPH_API_BASE, type MessengerProbeResult } from "./types.js";

export async function probeMessengerPage(
  pageAccessToken: string,
  timeoutMs = 5000,
): Promise<MessengerProbeResult> {
  if (!pageAccessToken?.trim()) {
    return { ok: false, error: "Page access token not configured" };
  }

  try {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    const res = await fetch(`${GRAPH_API_BASE}/me?fields=name,id`, {
      headers: { Authorization: `Bearer ${pageAccessToken.trim()}` },
      signal: controller.signal,
    }).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = (await res.json()) as { name?: string; id?: string };

    return {
      ok: true,
      page: {
        name: data.name,
        id: data.id,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
