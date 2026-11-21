import { afterEach } from "vitest";

type RequestModule = typeof import("./mcp-http.request.js");

/**
 * Production waits a fixed five seconds for native authority. Timeout cases shorten it
 * through `ms`; `onEnter` fires when a request reads the bound, which is the moment it
 * enters the wait, so a test can publish authority while the request is provably waiting.
 */
export const nativeAuthorityWait: { ms?: number; onEnter?: () => void } = {};

afterEach(() => {
  nativeAuthorityWait.ms = undefined;
  nativeAuthorityWait.onEnter = undefined;
});

/** Module-mock factory: the real request module with only the wait bound overridable. */
export async function mockNativeAuthorityWait(
  importOriginal: () => Promise<RequestModule>,
): Promise<RequestModule> {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveMcpNativeToolAllowlistWaitTimeoutMs: () => {
      nativeAuthorityWait.onEnter?.();
      return nativeAuthorityWait.ms ?? actual.resolveMcpNativeToolAllowlistWaitTimeoutMs();
    },
  };
}
