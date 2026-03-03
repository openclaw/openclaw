import { ProxyAgent, fetch as undiciFetch } from "undici";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";

/**
 * Patch a @buape/carbon Client's rest property to route all Discord REST API
 * requests through a proxy. This works around carbon's RequestClient not
 * supporting a custom fetch / dispatcher option.
 *
 * The approach: replace the global `fetch` visible to `executeRequest` by
 * wrapping the method so that during its execution, every `fetch()` call
 * goes through an undici ProxyAgent dispatcher.
 *
 * No-op when `proxyUrl` is empty/undefined.
 */

const PATCHED = Symbol("openclawProxyPatched");

type RestLike = Record<string, unknown> & {
  executeRequest?: (request: unknown) => Promise<unknown>;
  [PATCHED]?: boolean;
};

type CarbonClientLike = {
  rest?: RestLike;
};

export function patchCarbonRestProxy(
  client: CarbonClientLike,
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): void {
  const proxy = proxyUrl?.trim();
  if (!proxy) return;

  const rest = client.rest;
  if (!rest || typeof rest.executeRequest !== "function" || rest[PATCHED]) return;

  try {
    const agent = new ProxyAgent(proxy);
    const originalExecuteRequest = rest.executeRequest.bind(rest);

    // Wrap executeRequest to intercept the internal fetch() call.
    // Carbon's executeRequest builds url/headers/body then calls fetch(url, init).
    // We replace it with a version that injects `dispatcher` into the fetch init.
    const proxyFetch = ((input: string | URL | RequestInfo, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof globalThis.fetch;

    rest.executeRequest = async function patchedExecuteRequest(
      this: RestLike,
      request: unknown,
    ): Promise<unknown> {
      // Temporarily replace globalThis.fetch so carbon's executeRequest picks it up.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = proxyFetch;
      try {
        return await originalExecuteRequest(request);
      } finally {
        globalThis.fetch = originalFetch;
      }
    };

    rest[PATCHED] = true;
    runtime.log?.("discord: carbon rest proxy enabled");
  } catch (err) {
    runtime.error?.(danger(`discord: invalid carbon rest proxy: ${String(err)}`));
  }
}
