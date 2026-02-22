const DEFAULT_BASE_URL = "https://live-mt-server.wati.io";

export type WatiApiOpts = {
  apiToken: string;
  baseUrl?: string;
};

/**
 * Shared HTTP helper for WATI REST API calls.
 * Prepends baseUrl, adds Bearer auth header, throws on non-ok responses.
 */
export async function watiApiRequest(
  path: string,
  init: RequestInit,
  opts: WatiApiOpts,
): Promise<Response> {
  const base = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WATI API error ${res.status}: ${body}`);
  }

  return res;
}
