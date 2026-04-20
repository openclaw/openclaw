import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./onboard-auth.models.js";

/** Prefer Turbo / 5.1; keep `glm-5` last (deprecated API id after 2026-04-20). */
const ZAI_GENERAL_PROBE_MODEL_IDS = ["glm-5-turbo", "glm-5.1", "glm-5"] as const;

export type ZaiEndpointId = "global" | "cn" | "coding-global" | "coding-cn";

export type ZaiDetectedEndpoint = {
  endpoint: ZaiEndpointId;
  /** Provider baseUrl to store in config. */
  baseUrl: string;
  /** Recommended default model id for that endpoint. */
  modelId: string;
  /** Human-readable note explaining the choice. */
  note: string;
};

type ProbeResult =
  | { ok: true }
  | {
      ok: false;
      status?: number;
      errorCode?: string;
      errorMessage?: string;
    };

async function probeZaiChatCompletions(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): Promise<ProbeResult> {
  try {
    const res = await fetchWithTimeout(
      `${params.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: params.modelId,
          stream: false,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      },
      params.timeoutMs,
      params.fetchFn,
    );

    if (res.ok) {
      return { ok: true };
    }

    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    try {
      const json = (await res.json()) as {
        error?: { code?: unknown; message?: unknown };
        msg?: unknown;
        message?: unknown;
      };
      const code = json?.error?.code;
      const msg = json?.error?.message ?? json?.msg ?? json?.message;
      if (typeof code === "string") {
        errorCode = code;
      } else if (typeof code === "number") {
        errorCode = String(code);
      }
      if (typeof msg === "string") {
        errorMessage = msg;
      }
    } catch {
      // ignore
    }

    return { ok: false, status: res.status, errorCode, errorMessage };
  } catch {
    return { ok: false };
  }
}

export async function detectZaiEndpoint(params: {
  apiKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<ZaiDetectedEndpoint | null> {
  // Never auto-probe in vitest; it would create flaky network behavior.
  if (process.env.VITEST && !params.fetchFn) {
    return null;
  }

  const timeoutMs = params.timeoutMs ?? 5_000;

  // Prefer GLM-5 Turbo / 5.1 on general API endpoints (see ZAI_GENERAL_PROBE_MODEL_IDS).
  const generalEndpoints: Array<{ endpoint: ZaiEndpointId; baseUrl: string }> = [
    { endpoint: "global", baseUrl: ZAI_GLOBAL_BASE_URL },
    { endpoint: "cn", baseUrl: ZAI_CN_BASE_URL },
  ];
  for (const candidate of generalEndpoints) {
    for (const modelId of ZAI_GENERAL_PROBE_MODEL_IDS) {
      const result = await probeZaiChatCompletions({
        baseUrl: candidate.baseUrl,
        apiKey: params.apiKey,
        modelId,
        timeoutMs,
        fetchFn: params.fetchFn,
      });
      if (result.ok) {
        let note = `Verified GLM (${modelId}) on ${candidate.endpoint} endpoint.`;
        if (modelId === "glm-5") {
          note += " API id glm-5 is deprecated after 2026-04-20; prefer glm-5-turbo or glm-5.1.";
        }
        return {
          endpoint: candidate.endpoint,
          baseUrl: candidate.baseUrl,
          modelId,
          note,
        };
      }
    }
  }

  // Fallback: Coding Plan endpoint (GLM-5.x general models may not be available there).
  const coding: Array<{ endpoint: ZaiEndpointId; baseUrl: string }> = [
    { endpoint: "coding-global", baseUrl: ZAI_CODING_GLOBAL_BASE_URL },
    { endpoint: "coding-cn", baseUrl: ZAI_CODING_CN_BASE_URL },
  ];
  for (const candidate of coding) {
    const result = await probeZaiChatCompletions({
      baseUrl: candidate.baseUrl,
      apiKey: params.apiKey,
      modelId: "glm-4.7",
      timeoutMs,
      fetchFn: params.fetchFn,
    });
    if (result.ok) {
      return {
        endpoint: candidate.endpoint,
        baseUrl: candidate.baseUrl,
        modelId: "glm-4.7",
        note: "Coding Plan endpoint detected; GLM-5 is not available there. Defaulting to GLM-4.7.",
      };
    }
  }

  return null;
}
