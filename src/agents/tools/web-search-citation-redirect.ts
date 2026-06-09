/**
 * Citation redirect resolver for web search results.
 *
 * Follows provider citation redirect URLs with a short HEAD request timeout.
 */
import { fetchUntrustedUrl } from "../../infra/net/egress-fetch.js";

const REDIRECT_TIMEOUT_MS = 5000;

/**
 * Resolve a citation redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
export async function resolveCitationRedirectUrl(url: string): Promise<string> {
  let fetched: Awaited<ReturnType<typeof fetchUntrustedUrl>> | undefined;
  try {
    fetched = await fetchUntrustedUrl({
      url,
      timeoutMs: REDIRECT_TIMEOUT_MS,
      operation: "web-search-citation-redirect",
      init: {
        method: "HEAD",
      },
    });
    return fetched.finalUrl || url;
  } catch {
    return url;
  } finally {
    await fetched?.release().catch(() => undefined);
  }
}
