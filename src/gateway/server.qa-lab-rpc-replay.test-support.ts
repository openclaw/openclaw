import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";

export async function requestQaReplayControl(baseUrl: string, token: string, action = "snapshot") {
  // Fixture controls target this owned loopback listener, not the ambient proxy.
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/__fixture`,
    policy: { allowedOrigins: [baseUrl] },
    init: {
      method: "POST",
      headers: { "x-qa-fixture-token": token, "content-type": "application/json" },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(5_000),
    },
  });
  try {
    if (!response.ok) {
      throw new Error(`proxy control failed: ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    await release();
  }
}
