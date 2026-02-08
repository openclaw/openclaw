import type { HitlCreateRequestPayload } from "./types.js";
import { parseHitlCreateRequestResponse } from "./types.js";

export type HitlCreateRequestOptions = {
  apiKey: string;
  loopId: string;
  request: HitlCreateRequestPayload;
};

export type HitlCreateRequestResult =
  | { ok: true; requestId: string; raw: unknown }
  | { ok: false; error: string; status?: number; raw?: unknown };

const HITL_BASE_URL = "https://api.hitl.sh";

export async function createHitlRequest(
  opts: HitlCreateRequestOptions,
): Promise<HitlCreateRequestResult> {
  const apiKey = opts.apiKey.trim();
  const loopId = opts.loopId.trim();
  if (!apiKey || !loopId) {
    return { ok: false, error: "missing hitl apiKey or loopId" };
  }
  const url = `${HITL_BASE_URL}/v1/api/loops/${encodeURIComponent(loopId)}/requests`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.request),
    });
  } catch (err) {
    return { ok: false, error: `hitl request failed: ${String(err)}` };
  }

  let raw: unknown = null;
  try {
    raw = (await res.json()) as unknown;
  } catch {
    raw = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `hitl http ${res.status}`,
      status: res.status,
      raw,
    };
  }

  const parsed = parseHitlCreateRequestResponse(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, raw };
  }
  return { ok: true, requestId: parsed.requestId, raw };
}
