/**
 * Citation redirect resolver for web search results.
 *
 * Follows provider citation redirect URLs through the strict web-tools network guard.
 */
import { withStrictWebToolsEndpoint } from "./web-guarded-fetch.js";

const REDIRECT_TIMEOUT_MS = 5000;

/**
 * Resolve a citation redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out; caller cancellation is preserved.
 */
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
