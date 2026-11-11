import { withStrictWebToolsEndpoint } from "./web-guarded-fetch.js";

const REDIRECT_TIMEOUT_MS = 5000;

export async function resolveCitationRedirectUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  try {
    const resolved = await withStrictWebToolsEndpoint(
      {
        url,
        init: { method: "HEAD" },
        timeoutMs: REDIRECT_TIMEOUT_MS,
        signal,
      },
      async ({ finalUrl }) => finalUrl || url,
    );
    signal?.throwIfAborted();
    return resolved;
  } catch {
    signal?.throwIfAborted();
    return url;
  }
}
