import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "../../extensions/zai/api.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

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
  endpoint?: ZaiEndpointId;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<ZaiDetectedEndpoint | null> {
  // Never auto-probe in vitest; it would create flaky network behavior.
  if (process.env.VITEST && !params.fetchFn) {
    return null;
  }

  const timeoutMs = params.timeoutMs ?? 5_000;
  const probeCandidates = (() => {
    const general = [
      {
        endpoint: "global" as const,
        baseUrl: ZAI_GLOBAL_BASE_URL,
        modelId: "glm-5",
        note: "Verified GLM-5 on global endpoint.",
      },
      {
        endpoint: "cn" as const,
        baseUrl: ZAI_CN_BASE_URL,
        modelId: "glm-5",
        note: "Verified GLM-5 on cn endpoint.",
      },
    ];
    const codingGlm5 = [
      {
        endpoint: "coding-global" as const,
        baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
        modelId: "glm-5",
        note: "Verified GLM-5 on coding-global endpoint.",
      },
      {
        endpoint: "coding-cn" as const,
        baseUrl: ZAI_CODING_CN_BASE_URL,
        modelId: "glm-5",
        note: "Verified GLM-5 on coding-cn endpoint.",
      },
    ];
    const codingFallback = [
      {
        endpoint: "coding-global" as const,
        baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
        modelId: "glm-4.7",
        note: "Coding Plan endpoint verified, but this key/plan does not expose GLM-5 there. Defaulting to GLM-4.7.",
      },
      {
        endpoint: "coding-cn" as const,
        baseUrl: ZAI_CODING_CN_BASE_URL,
        modelId: "glm-4.7",
        note: "Coding Plan CN endpoint verified, but this key/plan does not expose GLM-5 there. Defaulting to GLM-4.7.",
      },
    ];

    switch (params.endpoint) {
      case "global":
        return general.filter((candidate) => candidate.endpoint === "global");
      case "cn":
        return general.filter((candidate) => candidate.endpoint === "cn");
      case "coding-global":
        return [
          ...codingGlm5.filter((candidate) => candidate.endpoint === "coding-global"),
          ...codingFallback.filter((candidate) => candidate.endpoint === "coding-global"),
        ];
      case "coding-cn":
        return [
          ...codingGlm5.filter((candidate) => candidate.endpoint === "coding-cn"),
          ...codingFallback.filter((candidate) => candidate.endpoint === "coding-cn"),
        ];
      default:
        return [...general, ...codingGlm5, ...codingFallback];
    }
  })();

  for (const candidate of probeCandidates) {
    const result = await probeZaiChatCompletions({
      baseUrl: candidate.baseUrl,
      apiKey: params.apiKey,
      modelId: candidate.modelId,
      timeoutMs,
      fetchFn: params.fetchFn,
    });
    if (result.ok) {
      return candidate;
    }
  }

  return null;
}
