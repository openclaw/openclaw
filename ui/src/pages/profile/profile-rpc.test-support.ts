import { vi } from "vitest";

export const disconnectedGitHub = {
  personal: {
    state: "disconnected",
    generation: null,
    account: null,
    accessExpiresAtMs: null,
    refreshState: "not_applicable",
    pending: null,
  },
  system: {
    source: "system-detected",
    credentialKind: "native",
    credentialState: "unavailable",
    account: null,
    gitAuthor: { name: null, email: null },
    evidence: "none",
    accessExpiresAtMs: null,
    refreshState: "not_applicable",
    oauthScopes: [],
    repositoryGrants: "unknown",
  },
};
export function mockRpc(handlers: Record<string, (params?: unknown) => unknown>) {
  return vi.fn(async (method: string, params?: unknown) => {
    const handler = handlers[method];
    if (!Object.hasOwn(handlers, method) || !handler) {
      throw new Error(`unexpected method: ${method}`);
    }
    return handler(params);
  });
}
