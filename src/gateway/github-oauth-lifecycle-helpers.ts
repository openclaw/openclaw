import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../agents/agent-lifecycle-registry.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import {
  inspectGitHubOAuthRecord,
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  type GitHubDeviceAuthorizationRecord,
  type GitHubIdentityScope,
  type GitHubOAuthRecord,
} from "../agents/github-oauth-records.js";
import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { subscribeSecretStoreChanges } from "../secrets/store/secret-store-changes.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export const REFRESH_SKEW_MS = 10 * 60_000;
export const MAINTENANCE_INTERVAL_MS = 60_000;
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 31_000;

type GitHubOAuthInventory = {
  deviceRecords: Awaited<ReturnType<typeof listGitHubDeviceAuthorizationRecords>>;
  oauthRecords: Awaited<ReturnType<typeof listGitHubOAuthRecords>>;
};

export function createGitHubOAuthInventoryReader(onChange: () => void) {
  let dirty = true;
  let databasePath: string | undefined;
  let snapshot: GitHubOAuthInventory | undefined;
  const invalidate = () => {
    dirty = true;
    onChange();
  };
  const unsubscribe = subscribeSecretStoreChanges((change) => {
    if (change.githubOAuth && change.databasePath === resolveOpenClawStateSqlitePath()) {
      invalidate();
    }
  });
  const unregisterResource = registerOpenClawStateDatabaseAsyncResource({
    async close() {
      snapshot = undefined;
      invalidate();
    },
  });
  const unsubscribeLifecycle = registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened" && event.path === resolveOpenClawStateSqlitePath()) {
      snapshot = undefined;
      invalidate();
    }
  });
  return {
    async read() {
      const path = resolveOpenClawStateSqlitePath();
      if (snapshot && !dirty && databasePath === path) {
        return snapshot;
      }
      databasePath = path;
      dirty = false;
      try {
        const deviceRecords = await listGitHubDeviceAuthorizationRecords();
        const oauthRecords = await listGitHubOAuthRecords();
        snapshot = { deviceRecords, oauthRecords };
        return snapshot;
      } catch (error) {
        dirty = true;
        throw error;
      }
    },
    get dirty() {
      return dirty;
    },
    close() {
      unsubscribe();
      unsubscribeLifecycle();
      unregisterResource();
      snapshot = undefined;
    },
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

export function nextGitHubOAuthMaintenanceAtMs(
  inventory: GitHubOAuthInventory,
  now: number,
): number {
  const retryAtMs = now + MAINTENANCE_INTERVAL_MS;
  let next = Number.POSITIVE_INFINITY;
  for (const { record } of inventory.deviceRecords) {
    if (record) {
      next = Math.min(next, record.expiresAtMs > now ? record.expiresAtMs : retryAtMs);
    }
  }
  for (const { record } of inventory.oauthRecords) {
    if (!record) {
      continue;
    }
    if (record.pendingInitial || record.pendingRefresh || record.refreshFailure === "failed") {
      next = Math.min(next, retryAtMs);
    } else if (record.refreshFailure !== "expired" && record.refreshExpiresAtMs > now) {
      next = Math.min(next, Math.max(retryAtMs, record.accessExpiresAtMs - REFRESH_SKEW_MS));
    }
  }
  return next;
}

export async function assertInitialOAuthRecordCurrent(
  getConfig: () => OpenClawConfig,
  expected: GitHubOAuthRecord,
  runtimeConfig: OpenClawConfig,
  runtimeConfigValue: OpenClawConfig,
): Promise<void> {
  const current = await inspectGitHubOAuthRecord(expected.profileId);
  if (
    getConfig() !== runtimeConfig ||
    !isDeepStrictEqual(runtimeConfig, runtimeConfigValue) ||
    current.state !== "valid" ||
    !isDeepStrictEqual(current.record, expected)
  ) {
    throw new Error("GitHub OAuth initial reconciliation was superseded.");
  }
}

export async function pendingInitialOAuthIdentitySelected(
  config: OpenClawConfig,
  record: GitHubOAuthRecord,
): Promise<boolean> {
  const identity = resolveConfiguredGitHubToolIdentity({ config, ...record });
  const binding = record.pendingInitial?.agentLifecycleBinding;
  const agentBindingMatches =
    record.scope === "system" ||
    (binding !== undefined && (await matchesAgentLifecycleBindingAsync(() => config, binding)));
  return (
    agentBindingMatches && identity?.profileId === record.profileId && identity.kind === "oauth"
  );
}
