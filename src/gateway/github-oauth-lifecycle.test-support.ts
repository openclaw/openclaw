import {
  createNativeGitHubOAuthStateHostV1 as createRepositoryOAuthStateHostV1,
  type NativeGitHubToolAccount as GitHubToolAccount,
} from "openclaw/plugin-sdk/native-github-account-host";
import { expect, onTestFinished } from "vitest";
import type { ToolsGitHubStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { inspectGitHubOAuthRecord } from "../agents/github-oauth-records.js";
import type { GitHubIdentityScope, GitHubOAuthRecord } from "../agents/github-oauth-records.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startTestRepositorySessionPresentation } from "./github-account-service.test-support.js";
import type { LegacyGitHubOAuthService } from "./github-oauth-lifecycle-host.types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

// Fixture mutation only needs profile selection; plugin configuration validation stays plugin-owned.
type SelectedProfile = { profileId: string };
export const { readGitHubConfig } = await loadBundledPluginFacade<{
  readGitHubConfig(config: OpenClawConfig): {
    system?: GitHubToolIdentityConfig;
    agents?: Record<string, GitHubToolIdentityConfig>;
  };
}>({ pluginId: "github-repositories", artifactBasename: "config-api.js" });

export const NOW = Date.parse("2026-08-19T12:00:00.000Z");
export const OLD_PROFILE = `ghp_${"1".repeat(32)}`;
export const NEW_PROFILE = `ghp_${"2".repeat(32)}`;
export const OTHER_PROFILE = `ghp_${"3".repeat(32)}`;
export const ACCOUNT: GitHubToolAccount = { accountId: 42, login: "roboclaw", avatarUrl: null };

export const TOKENS = {
  accessToken: "access-token-secret",
  tokenType: "bearer" as const,
  scopes: ["gist", "read:org", "repo", "workflow"],
  expiresInSeconds: 28_800,
  refreshToken: "refresh-token-secret",
  refreshTokenExpiresInSeconds: 15_897_600,
};

export function identity(profileId: string, options: { oauth?: boolean; author?: boolean } = {}) {
  return {
    profileId,
    ...(options.oauth ? { kind: "oauth" as const } : {}),
    ...(options.author
      ? { gitAuthor: { name: "Configured Author", email: "author@example.com" } }
      : {}),
  };
}

export function configForScope<T extends SelectedProfile>(
  scope: GitHubIdentityScope,
  selected?: T,
): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "github-repositories": {
          config: {
            system: scope === "system" ? selected : identity(OTHER_PROFILE),
            ...(scope === "agent" && selected ? { agents: { main: selected } } : {}),
          },
        },
      },
    },
    agents: { entries: { main: {} } },
  };
}

export function configWithSelectedIdentity<T extends SelectedProfile>(
  config: OpenClawConfig,
  scope: GitHubIdentityScope,
  agentId: string,
  nextIdentity: T,
): OpenClawConfig {
  const next = structuredClone(config);
  const owner = readGitHubConfig(next);
  if (scope === "system") {
    owner.system = structuredClone(nextIdentity);
  } else {
    (owner.agents ??= {})[agentId] = structuredClone(nextIdentity);
  }
  return next;
}

export function statusResult(scope: GitHubIdentityScope): ToolsGitHubStatusResult {
  return {
    agentId: "main",
    selectedScope: scope,
    selected: { scope, configured: true, identity: null },
    effective: {
      source: scope === "agent" ? "agent-override" : "system-configured",
      credentialKind: "managed-oauth",
      credentialState: "available",
      account: { login: ACCOUNT.login },
      gitAuthor: { name: ACCOUNT.login, email: null },
      evidence: "github-api",
      accessExpiresAtMs: NOW + TOKENS.expiresInSeconds * 1_000,
      refreshState: "available",
      oauthScopes: [...TOKENS.scopes],
      repositoryGrants: "unknown",
    },
  };
}

export function oauthRecord(
  profileId: string,
  overrides: Partial<GitHubOAuthRecord> = {},
): GitHubOAuthRecord {
  return {
    version: 1,
    profileId,
    scope: "system",
    agentId: "main",
    accountId: ACCOUNT.accountId,
    login: ACCOUNT.login,
    refreshToken: "refresh-token-current",
    accessExpiresAtMs: NOW + 5 * 60_000,
    refreshExpiresAtMs: NOW + 30 * 24 * 60 * 60_000,
    scopes: ["repo", "workflow"],
    createdAtMs: NOW - 60_000,
    ...overrides,
  };
}

export const createGitHubOAuthInventoryReader = (onChange: () => void) =>
  createRepositoryOAuthStateHostV1(new AbortController().signal).inventory.createReader(onChange);

export async function expectStoredOAuth(profileId: string, record: Record<string, unknown>) {
  expect(await inspectGitHubOAuthRecord(profileId)).toMatchObject({ state: "valid", record });
}

export const {
  resolveConfiguredGitHubToolIdentity,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
  GitHubAccountMismatchError,
} = await loadBundledPluginFacade<{
  resolveConfiguredGitHubToolIdentity(params: {
    config: OpenClawConfig;
    scope: GitHubIdentityScope;
    agentId: string;
  }): GitHubToolIdentityConfig | undefined;
  resolveManagedGitHubProfileDir(params: {
    scope: GitHubIdentityScope | "personal";
    agentId: string;
    profileId: string;
  }): string;
  writeManagedGitHubProfileFiles(
    dir: string,
    identity: { login: string; token: string },
  ): Promise<void>;
  GitHubAccountMismatchError: new (message?: string) => Error;
}>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.js" });
export const { requestCurrentGitHubOAuthRefresh } = await loadBundledPluginFacade<{
  requestCurrentGitHubOAuthRefresh(agentId: string): Promise<void>;
}>({ pluginId: "github-repositories", artifactBasename: "account-runtime-api.js" });
export const { clearGitHubCredentialVerificationCache, readRepositoryServices } =
  await loadBundledPluginFacade<{
    clearGitHubCredentialVerificationCache(): void;
    readRepositoryServices(
      context: import("./server-methods/types.js").GatewayRequestContext,
    ): { oauth: LegacyGitHubOAuthService } | undefined;
  }>({ pluginId: "github-repositories", artifactBasename: "runtime-api.js" });

/** Tests start the actual registered account owner, with the native scheduler they exercise. */
export async function startRegisteredGitHubOAuth(
  getConfig: () => OpenClawConfig,
  scheduler: GatewayScheduler = createTestGatewayScheduler(),
) {
  const context = createContext([], getConfig);
  context.resolveGatewayContext = () => context;
  const services = await startTestRepositorySessionPresentation(context, scheduler, undefined, {
    cleanupOnFinish: false,
  });
  const oauth = readRepositoryServices(context)?.oauth;
  if (!oauth) {
    throw new Error("Expected the registered GitHub OAuth service");
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      await services.stop({ strict: true });
    } finally {
      await scheduler.stop();
      resetPluginRuntimeStateForTest();
    }
  };
  onTestFinished(stop);
  return { oauth, context, stop };
}
