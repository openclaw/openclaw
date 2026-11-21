import { vi } from "vitest";
import type { GitHubIdentityFacts } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.ts";
import type { GatewayBrowserClient as Client } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createGitHubIdentityForTest } from "./github-identity.test-support.ts";

export const authorizationCode = {
  requestId: "33333333-3333-4333-8333-333333333333",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device" as const,
  expiresInMs: 60_000,
  pollAfterMs: 5_000,
};
export const availableIdentity = {
  source: "agent-override",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "managed-user" },
  gitAuthor: { name: "Agent Author", email: null },
  evidence: "github-api",
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
  oauthScopes: ["repo"],
  repositoryGrants: "unknown",
} satisfies GitHubIdentityFacts;
export const availableStatus = (scope: "system" | "agent" = "agent") =>
  ({
    agentId: "main",
    selectedScope: scope,
    selected: { scope, configured: true, identity: availableIdentity },
    effective: availableIdentity,
  }) as const;
export function sharedTarget(profileId = "profile-b", config: Record<string, unknown> = {}) {
  return { kind: "shared", scope: "system", agentId: "main", config, profileId } as const;
}
type Deps = Parameters<typeof createGitHubIdentityForTest>[0];
type RunMutation = RuntimeConfigCapability["runExternalMutation"];
type Behavior = { beforeDispatch?: () => void; refreshError?: string };
type Context = Partial<Parameters<ReturnType<typeof createGitHubIdentityForTest>["sync"]>[0]> & {
  config?: Record<string, unknown>;
  agentId?: string;
  scope?: "system" | "agent";
};
export function createIdentityFixture(client: Client, deps: Deps = {}, defaults: Context = {}) {
  const identity = createGitHubIdentityForTest(deps);
  const sync = (context: Context = {}) => {
    const merged = { ...defaults, ...context };
    const { config = {}, agentId = "main", scope = "system", ...overrides } = merged;
    identity.sync({
      client,
      connected: true,
      permissionsReady: overrides.connected ?? true,
      target: { ...sharedTarget("profile-a", config), agentId, scope },
      statusReadable: true,
      configurable: true,
      authorizable: true,
      clientRevision: 1,
      ...overrides,
    });
  };
  return { identity, sync };
}
export function setupRequest(
  respond: ((method: string, params?: unknown) => Promise<unknown>) | Record<string, () => unknown>,
  options: { mutation?: boolean; runExternalMutation?: RunMutation; context?: Context } = {},
) {
  const request = vi.fn(async (method: string, params?: unknown) => {
    const handler = typeof respond === "function" ? respond : respond[method];
    if (!handler) {
      throw new Error(`unexpected method ${method}`);
    }
    return handler(method, params);
  });
  const client = createTestGatewayClient(request);
  const runExternalMutation =
    options.runExternalMutation ?? (options.mutation ? createMutationRunner(client) : undefined);
  const fixture = createIdentityFixture(client, { runExternalMutation }, options.context);
  fixture.sync();
  return { ...fixture, request, client };
}
export const createMutationRunner =
  (client: Client, behavior: Behavior = {}): RunMutation =>
  async (task, options = {}) => {
    behavior.beforeDispatch?.();
    if (options.canDispatch && !options.canDispatch()) {
      const error = options.dispatchError ?? "Access changed.";
      return { ok: false, reason: "unavailable", error };
    }
    try {
      const value = await task(client);
      const error = behavior.refreshError;
      return { ok: true, value, refresh: error ? { ok: false, error } : { ok: true } };
    } catch (error) {
      return { ok: false, reason: "error", error: String(error) };
    }
  };
export async function forbidSharedMutation(): Promise<never> {
  throw new Error("Personal or view-only flow touched shared config");
}
