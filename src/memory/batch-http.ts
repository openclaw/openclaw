import { retryAsync } from "../infra/retry.js";

export async function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  errorPrefix: string;
}): Promise<T> {
  const res = await retryAsync(
    async () => {
      const res = await fetch(params.url, {
        method: "POST",
        headers: params.headers,
        body: JSON.stringify(params.body),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }
      return res;
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
  return (await res.json()) as T;
}
