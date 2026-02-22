import { retryHttpAsync } from "../infra/retry-http.js";

export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  const res = await retryHttpAsync(
    () =>
      fetch(params.url, {
        method: "POST",
        headers: params.headers,
        body: JSON.stringify(params.body),
      }),
    { label: "remote-embedding-fetch" },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${params.errorPrefix}: ${res.status} ${text}`);
  }
  const payload = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const data = payload.data ?? [];
  return data.map((entry) => entry.embedding ?? []);
}
