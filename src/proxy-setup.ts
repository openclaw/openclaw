import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Set a global proxy dispatcher when HTTP_PROXY / HTTPS_PROXY env vars are
 * present.  Uses {@link EnvHttpProxyAgent} so that NO_PROXY is respected
 * automatically — localhost traffic (Ollama, Kokoro, etc.) is never proxied
 * in AIO Docker setups.
 *
 * This is a no-op when no proxy env vars are set (zero startup cost).
 *
 * @see https://github.com/openclaw/openclaw/issues/2102
 */
export function applyProxyFromEnv(): void {
  if (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  ) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
}
