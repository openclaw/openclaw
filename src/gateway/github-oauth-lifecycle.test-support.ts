import { createNativeGitHubOAuthStateHostV1 as createRepositoryOAuthStateHostV1 } from "openclaw/plugin-sdk/native-github-account-host";
import { expect } from "vitest";
import {
  readGitHubConfig,
  type GitHubToolIdentityConfig,
} from "../../extensions/github-repositories/config-api.js";
import type { GitHubToolAccount } from "../../extensions/github-repositories/tool-account-api.js";
import type { ToolsGitHubStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { inspectGitHubOAuthRecord } from "../agents/github-oauth-records.js";
import type { GitHubIdentityScope, GitHubOAuthRecord } from "../agents/github-oauth-records.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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
  } satisfies GitHubToolIdentityConfig;
}

export function configForScope(
  scope: GitHubIdentityScope,
  selected?: GitHubToolIdentityConfig,
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

export function configWithSelectedIdentity(
  config: OpenClawConfig,
  scope: GitHubIdentityScope,
  agentId: string,
  nextIdentity: GitHubToolIdentityConfig,
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
