import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../agents/agent-lifecycle-registry.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import {
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  type GitHubDeviceAuthorizationRecord,
  type GitHubIdentityScope,
} from "../agents/github-oauth-records.js";
import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { readSqliteDatabaseWriteTokenForPath } from "../infra/sqlite-database-admission.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export const REFRESH_SKEW_MS = 10 * 60_000;
export const MAINTENANCE_INTERVAL_MS = 60_000;
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 31_000;

export function createGitHubOAuthInventoryReader() {
  let empty: { databasePath: string; writeToken: string } | undefined;
  return async () => {
    const databasePath = resolveOpenClawStateSqlitePath();
    const writeToken = readSqliteDatabaseWriteTokenForPath(databasePath);
    if (
      writeToken !== undefined &&
      empty?.databasePath === databasePath &&
      empty.writeToken === writeToken
    ) {
      return { deviceRecords: [], oauthRecords: [] };
    }
    const deviceRecords = await listGitHubDeviceAuthorizationRecords();
    const oauthRecords = await listGitHubOAuthRecords();
    // Keep the pre-read token: a write during either scan invalidates the next reuse.
    empty =
      writeToken !== undefined && deviceRecords.length === 0 && oauthRecords.length === 0
        ? { databasePath, writeToken }
        : undefined;
    return { deviceRecords, oauthRecords };
  };
}

export type ConfiguredOAuthIdentity = {
  scope: GitHubIdentityScope;
  agentId: string;
  identity: GitHubToolIdentityConfig & { kind: "oauth" };
};

export function identityStillSelected(
  config: OpenClawConfig,
  location: { scope: GitHubIdentityScope; agentId: string },
  expected: GitHubToolIdentityConfig | null,
): boolean {
  const current = resolveConfiguredGitHubToolIdentity({ config, ...location });
  return isDeepStrictEqual(current ?? null, expected);
}

export function authorizationStillOwned(
  config: OpenClawConfig,
  record: GitHubDeviceAuthorizationRecord,
): boolean {
  return (
    identityStillSelected(config, record, record.expectedIdentity) &&
    (record.scope === "system" ||
      (record.agentLifecycleBinding !== undefined &&
        matchesAgentLifecycleBinding(config, record.agentLifecycleBinding)))
  );
}

export async function authorizationStillOwnedAsync(
  getConfig: () => OpenClawConfig,
  record: GitHubDeviceAuthorizationRecord,
): Promise<boolean> {
  if (
    record.scope !== "system" &&
    (!record.agentLifecycleBinding ||
      !(await matchesAgentLifecycleBindingAsync(getConfig, record.agentLifecycleBinding)))
  ) {
    return false;
  }
  return identityStillSelected(getConfig(), record, record.expectedIdentity);
}

export function configuredOAuthIdentities(config: OpenClawConfig): ConfiguredOAuthIdentity[] {
  return withAgentRosterFactsBatch(config, () => {
    const identities: ConfiguredOAuthIdentity[] = [];
    const system = config.tools?.github;
    if (system?.kind === "oauth") {
      identities.push({
        scope: "system",
        agentId: "system",
        identity: { ...system, kind: "oauth" },
      });
    }
    for (const agentId of listAgentIds(config).toSorted()) {
      const identity = resolveAgentConfig(config, agentId)?.tools?.github;
      if (identity?.kind === "oauth") {
        identities.push({ scope: "agent", agentId, identity: { ...identity, kind: "oauth" } });
      }
    }
    return identities;
  });
}
