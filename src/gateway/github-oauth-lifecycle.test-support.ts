import type { GitHubIdentityScope, GitHubOAuthRecord } from "../agents/github-oauth-records.js";
import type { GitHubToolAccount } from "../agents/github-tool-account.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";

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
  return scope === "system"
    ? { tools: selected ? { github: selected } : {}, agents: { entries: { main: {} } } }
    : {
        tools: { github: identity(OTHER_PROFILE) },
        agents: { entries: { main: { tools: selected ? { github: selected } : {} } } },
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
