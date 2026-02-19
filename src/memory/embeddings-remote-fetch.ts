export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  const res = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify(params.body),
  });
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
