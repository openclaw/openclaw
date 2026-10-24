import { vi } from "vitest";
import type { GitHubIdentityFacts } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGitHubIdentityForTest,
  type TestGitHubIdentity,
} from "./github-identity.test-support.ts";

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
export function availableStatus(scope: "system" | "agent" = "agent") {
  return {
    agentId: "main",
    selectedScope: scope,
    selected: { scope, configured: true, identity: availableIdentity },
    effective: availableIdentity,
  } as const;
}
export function sharedTarget(profileId = "profile-b", config: Record<string, unknown> = {}) {
  return { kind: "shared", scope: "system", agentId: "main", config, profileId } as const;
}
type Context = Partial<Parameters<TestGitHubIdentity["sync"]>[0]> & {
  config?: Record<string, unknown>;
  agentId?: string;
  scope?: "system" | "agent";
};
export function createIdentityFixture(
  client: GatewayBrowserClient,
  deps: Parameters<typeof createGitHubIdentityForTest>[0] = {},
  defaults: Context = {},
) {
  const identity = createGitHubIdentityForTest(deps);
  const sync = (context: Context = {}) => {
    const {
      config = {},
      agentId = "main",
      scope = "system",
      ...overrides
    } = { ...defaults, ...context };
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
  options: {
    mutation?: boolean;
    runExternalMutation?: RuntimeConfigCapability["runExternalMutation"];
    context?: Context;
  } = {},
) {
  const request = vi.fn(
    typeof respond === "function"
      ? respond
      : async (method: string) => {
          const handler = respond[method];
          if (!handler) {
            throw new Error(`unexpected method ${method}`);
          }
          return handler();
        },
  );
  const client = createTestGatewayClient(request);
  const runExternalMutation =
    options.runExternalMutation ?? (options.mutation ? createMutationRunner(client) : undefined);
  const fixture = createIdentityFixture(client, { runExternalMutation }, options.context);
  fixture.sync();
  return { ...fixture, request, client };
}
export function createMutationRunner(
  client: GatewayBrowserClient,
  behavior: { beforeDispatch?: () => void; refreshError?: string } = {},
): RuntimeConfigCapability["runExternalMutation"] {
  return async (task, options = {}) => {
    behavior.beforeDispatch?.();
    if (options.canDispatch && !options.canDispatch()) {
      return {
        ok: false,
        reason: "unavailable",
        error: options.dispatchError ?? "Access changed.",
      };
    }
    try {
      return {
        ok: true,
        value: await task(client),
        refresh: behavior.refreshError ? { ok: false, error: behavior.refreshError } : { ok: true },
      };
    } catch (error) {
      return { ok: false, reason: "error", error: String(error) };
    }
  };
}
export async function forbidSharedMutation(): Promise<never> {
  throw new Error("Personal or view-only flow touched shared config");
}
