import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { retryAsync } from "../infra/retry.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export async function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
}): Promise<T> {
  return await retryAsync(
    async () => {
      return await withRemoteHttpResponse({
        url: params.url,
        ssrfPolicy: params.ssrfPolicy,
        init: {
          method: "POST",
          headers: params.headers,
          body: JSON.stringify(params.body),
        },
        onResponse: async (res) => {
          if (!res.ok) {
            const text = await res.text();
            const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
              status?: number;
            };
            err.status = res.status;
            throw err;
          }
          return (await res.json()) as T;
        },
      });
    },
    {
      attempts: 3,
      minDelayMs: 300,
      maxDelayMs: 2000,
      jitter: 0.2,
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
}
