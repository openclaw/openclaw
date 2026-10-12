import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../agents/agent-lifecycle-registry.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import {
  clearGitHubCredentialVerificationCache,
  refreshGitHubOAuthToken,
  type GitHubOAuthTokenPair,
} from "../agents/github-oauth-client.js";
import {
  createGitHubOAuthRecord,
  deleteGitHubDeviceAuthorizationRecord,
  deleteGitHubOAuthRecord,
  inspectGitHubOAuthRecord,
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  readGitHubDeviceAuthorizationRecord,
  type GitHubDeviceAuthorizationRecord,
  type GitHubIdentityScope,
  type GitHubOAuthRecord,
  writeGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
} from "../agents/github-oauth-records.js";
import {
  deleteGitHubDeviceAuthorizationRecordNative,
  deleteGitHubOAuthRecordNative,
  readGitHubDeviceAuthorizationRecordNative,
} from "../agents/github-oauth-records.native.js";
import { clearNativeGitHubTokenCache } from "../agents/github-read-identity.js";
import type { GitHubToolAccount } from "../agents/github-tool-account.js";
import {
  createManagedGitHubProfileId,
  GitHubAccountMismatchError,
  installManagedGitHubProfile,
  refreshManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { settlesWithin } from "../shared/settle-within.js";
import { assertGitHubCliAvailable } from "./github-cli-preflight.js";
import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from "./github-oauth-device-flow.js";
import {
  authorizationStillOwned,
  authorizationStillOwnedAsync,
  configuredOAuthIdentities,
  identityStillSelected,
  MAINTENANCE_INTERVAL_MS,
  REFRESH_SKEW_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  type ConfiguredOAuthIdentity,
} from "./github-oauth-lifecycle-helpers.js";
import { createPersonalGitHubOAuthLifecycle } from "./github-personal-oauth.js";
import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";

type GitHubOAuthLifecycle = ReturnType<typeof createGitHubOAuthLifecycle>;

let activeLifecycle: GitHubOAuthLifecycle | undefined;

export function installActiveGitHubOAuthLifecycle(lifecycle: GitHubOAuthLifecycle): () => void {
  activeLifecycle = lifecycle;
  return () => {
    if (activeLifecycle === lifecycle) {
      activeLifecycle = undefined;
    }
  };
}

export async function requestCurrentGitHubOAuthRefresh(agentId: string): Promise<void> {
  await activeLifecycle?.refreshEffectiveIdentity(agentId);
}

export async function requestCurrentPersonalGitHubRefresh(owner: string): Promise<void> {
  if (!activeLifecycle) {
    throw new Error("My GitHub lifecycle is unavailable; retry after Gateway startup.");
  }
  await activeLifecycle.personal.refresh(owner);
}

export function createGitHubOAuthLifecycle(params: {
  getConfig: () => OpenClawConfig;
  getPersistedConfig?: () => Promise<OpenClawConfig>;
  warn: (message: string) => void;
  scheduler: GatewayScheduler;
}) {
  const personal = createPersonalGitHubOAuthLifecycle();
  const deviceController = new AbortController();
  const devicePolls = new Map<string, Promise<ToolsGitHubAuthorizePollResult>>();
  const committingRequests = new Set<string>();
  const refreshes = new Map<string, Promise<void>>();
  const pendingRefreshes = new Map<
    string,
    { record: GitHubOAuthRecord & { pendingRefresh: true }; accessToken: string }
  >();
  const pendingCleanup = new Set<string>();
  let maintenance: Promise<void> | undefined;
  let maintenanceScope: GatewaySchedulerScope | undefined;
  let stopping = false;
  const warnMaintenanceError = (error: unknown) => {
    params.warn(`GitHub OAuth maintenance failed; will retry: ${formatErrorMessage(error)}`);
  };

  const queueDeviceCleanup = async (requestId: string) => {
    try {
      await deleteGitHubDeviceAuthorizationRecord(requestId);
      pendingCleanup.delete(requestId);
    } catch {
      pendingCleanup.add(requestId);
    }
  };

  const queueOAuthCleanup = async (profileId: string) => {
    clearNativeGitHubTokenCache();
    try {
      await deleteGitHubOAuthRecord(profileId);
    } catch {
      // Orphan cleanup scans every minute and after restart.
    }
  };

  const status = (agentId: string, selectedScope: GitHubIdentityScope) =>
    resolveGitHubToolIdentityStatus({ config: params.getConfig(), agentId, selectedScope });

  const assertInitialRecordCurrent = async (
    expected: GitHubOAuthRecord,
    runtimeConfig: OpenClawConfig,
    runtimeConfigValue: OpenClawConfig,
  ): Promise<void> => {
    const current = await inspectGitHubOAuthRecord(expected.profileId);
    if (
      params.getConfig() !== runtimeConfig ||
      !isDeepStrictEqual(runtimeConfig, runtimeConfigValue) ||
      current.state !== "valid" ||
      !isDeepStrictEqual(current.record, expected)
    ) {
      throw new Error("GitHub OAuth initial reconciliation was superseded.");
    }
  };

  const installDeviceTokens = async (
    record: GitHubDeviceAuthorizationRecord,
    tokens: GitHubOAuthTokenPair,
  ): Promise<ToolsGitHubAuthorizePollResult> => {
    if (!(await authorizationStillOwnedAsync(params.getConfig, record))) {
      await queueDeviceCleanup(record.requestId);
      return { status: "failed", reason: "identity_changed" };
    }
    const current = params.getConfig();
    const profileId = createManagedGitHubProfileId();
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: record.agentId,
      scope: record.scope,
      profileId,
    });
    let nextConfig = current;
    let initialRecord: GitHubOAuthRecord | undefined;
    const completeAuthorization = async (
      config: OpenClawConfig,
    ): Promise<ToolsGitHubAuthorizePollResult> => {
      await queueDeviceCleanup(record.requestId);
      if (record.expectedIdentity?.kind === "oauth") {
        await queueOAuthCleanup(record.expectedIdentity.profileId);
      }
      return {
        status: "success",
        githubStatus: await resolveGitHubToolIdentityStatus({
          config,
          agentId: record.agentId,
          selectedScope: record.scope,
        }),
      };
    };
    try {
      await installManagedGitHubProfile({
        profileDir,
        token: tokens.accessToken,
        retainProfileOnCommitFailure: true,
        commitConfig: async (account) => {
          const pending = await readGitHubDeviceAuthorizationRecord(record.requestId);
          if (
            !pending ||
            pending.createdAtMs !== record.createdAtMs ||
            pending.deviceCode !== record.deviceCode ||
            !isDeepStrictEqual(pending.expectedIdentity, record.expectedIdentity) ||
            !authorizationStillOwned(params.getConfig(), record)
          ) {
            throw new Error("GitHub authorization is no longer pending.");
          }
          committingRequests.add(record.requestId);
          const pendingInitial = {
            requestId: record.requestId,
            scope: record.scope,
            agentId: record.agentId,
            expectedIdentity: record.expectedIdentity,
            ...(record.agentLifecycleBinding
              ? { agentLifecycleBinding: record.agentLifecycleBinding }
              : {}),
          } as const;
          const nextRecord = createGitHubOAuthRecord({
            profileId,
            scope: record.scope,
            agentId: record.agentId,
            account,
            tokens,
            now: Date.now(),
            pendingInitial,
          });
          await writeGitHubOAuthRecord(nextRecord);
          initialRecord = nextRecord;
          const identity: GitHubToolIdentityConfig = {
            profileId,
            kind: "oauth",
            gitAuthor: record.expectedIdentity?.gitAuthor
              ? structuredClone(record.expectedIdentity.gitAuthor)
              : {
                  name: account.login,
                  email: `${account.accountId}+${account.login}@users.noreply.github.com`,
                },
          };
          nextConfig = await updateGitHubToolIdentityConfig({
            scope: record.scope,
            agentId: record.agentId,
            identity,
            expectedIdentity: record.expectedIdentity,
            ...(record.agentLifecycleBinding
              ? { agentLifecycleBinding: record.agentLifecycleBinding }
              : {}),
          });
          const inspected = await inspectGitHubOAuthRecord(profileId);
          if (inspected.state !== "valid" || !inspected.record.pendingInitial) {
            throw new Error("GitHub OAuth initial record is unavailable.");
          }
          const { pendingInitial: _pendingInitial, ...settledRecord } = inspected.record;
          await writeGitHubOAuthRecord(settledRecord);
          initialRecord = settledRecord;
        },
      });
    } catch {
      if (initialRecord) {
        try {
          const runtimeConfig = params.getConfig();
          const runtimeConfigValue = structuredClone(runtimeConfig);
          const persistedConfig = await params.getPersistedConfig?.();
          if (!persistedConfig) {
            throw new Error("Authoritative persisted config is unavailable.");
          }
          await assertInitialRecordCurrent(initialRecord, runtimeConfig, runtimeConfigValue);
          const persistedIdentity = resolveConfiguredGitHubToolIdentity({
            config: persistedConfig,
            scope: record.scope,
            agentId: record.agentId,
          });
          if (persistedIdentity?.profileId === profileId && persistedIdentity.kind === "oauth") {
            if (initialRecord.pendingInitial) {
              await writeGitHubOAuthRecord({ ...initialRecord, pendingInitial: undefined });
            }
            return await completeAuthorization(persistedConfig);
          }
        } catch {
          // The commit outcome is unknown. Preserve the profile and refresh
          // record so lifecycle reconciliation can decide from durable config.
          await queueDeviceCleanup(record.requestId);
          return { status: "failed", reason: "setup_failed" };
        }
      }
      if (initialRecord) {
        await queueOAuthCleanup(profileId);
      }
      await removeManagedGitHubProfile(profileDir).catch(() => undefined);
      await queueDeviceCleanup(record.requestId);
      return { status: "failed", reason: "setup_failed" };
    } finally {
      committingRequests.delete(record.requestId);
    }
    return await completeAuthorization(nextConfig);
  };

  const pollOnce = async (requestId: string): Promise<ToolsGitHubAuthorizePollResult> => {
    const record = await readGitHubDeviceAuthorizationRecord(requestId);
    const now = Date.now();
    if (!record || record.expiresAtMs <= now) {
      await queueDeviceCleanup(requestId);
      return { status: "expired" };
    }
    if (!authorizationStillOwned(params.getConfig(), record)) {
      await queueDeviceCleanup(requestId);
      return { status: "failed", reason: "identity_changed" };
    }
    const result = await pollGitHubDeviceFlow(record, deviceController.signal);
    const currentRecord = await readGitHubDeviceAuthorizationRecord(requestId);
    if (!currentRecord) {
      return { status: "expired" };
    }
    if (
      currentRecord.deviceCode !== record.deviceCode ||
      currentRecord.createdAtMs !== record.createdAtMs ||
      !isDeepStrictEqual(currentRecord.expectedIdentity, record.expectedIdentity)
    ) {
      await queueDeviceCleanup(requestId);
      return { status: "failed", reason: "identity_changed" };
    }
    if (result.kind === "authorized") {
      return await installDeviceTokens(currentRecord, result.tokens);
    }
    if (result.kind === "waiting") {
      await writeGitHubDeviceAuthorizationRecord({
        ...currentRecord,
        pollIntervalMs: result.pollIntervalMs,
        nextPollAtMs: result.nextPollAtMs,
      });
    } else {
      await queueDeviceCleanup(requestId);
    }
    return result.result;
  };

  const applyPendingRefresh = async (
    record: GitHubOAuthRecord & { pendingRefresh: true },
    accessToken: string,
  ): Promise<void> => {
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: record.agentId,
      scope: record.scope,
      profileId: record.profileId,
    });
    let account: GitHubToolAccount;
    try {
      account = await refreshManagedGitHubProfile({
        profileDir,
        token: accessToken,
        expectedAccountId: record.accountId,
      });
    } catch (error) {
      if (error instanceof GitHubAccountMismatchError) {
        await writeGitHubOAuthRecord({
          ...record,
          pendingRefresh: undefined,
          refreshFailure: "expired",
        });
      }
      return;
    }
    await writeGitHubOAuthRecord({
      ...record,
      login: account.login,
      pendingRefresh: undefined,
      refreshFailure: undefined,
    });
  };

  const refreshOne = async (configured: ConfiguredOAuthIdentity): Promise<void> => {
    const profileId = configured.identity.profileId;
    const inspected = await inspectGitHubOAuthRecord(profileId);
    if (inspected.state !== "valid") {
      return;
    }
    const currentRecord = inspected.record;
    if (currentRecord.pendingInitial) {
      return;
    }
    const now = Date.now();
    if (currentRecord.refreshFailure === "expired" || currentRecord.refreshExpiresAtMs <= now) {
      return;
    }
    if (!currentRecord.pendingRefresh && currentRecord.accessExpiresAtMs > now + REFRESH_SKEW_MS) {
      return;
    }
    const currentIdentity = resolveConfiguredGitHubToolIdentity({
      config: params.getConfig(),
      ...currentRecord,
    });
    if (currentIdentity?.kind !== "oauth" || currentIdentity.profileId !== profileId) {
      return;
    }
    let refreshed;
    try {
      refreshed = await refreshGitHubOAuthToken({
        refreshToken: currentRecord.refreshToken,
      });
    } catch {
      if (!currentRecord.pendingRefresh) {
        await writeGitHubOAuthRecord({ ...currentRecord, refreshFailure: "failed" });
      }
      return;
    }
    if (refreshed.status === "error") {
      const refreshFailure = refreshed.code === "bad_refresh_token" ? "expired" : "failed";
      await writeGitHubOAuthRecord({
        ...currentRecord,
        pendingRefresh: undefined,
        refreshFailure,
      });
      return;
    }
    const rotatedRecord: GitHubOAuthRecord & { pendingRefresh: true } = {
      ...currentRecord,
      refreshToken: refreshed.tokens.refreshToken,
      accessExpiresAtMs: now + refreshed.tokens.expiresInSeconds * 1_000,
      refreshExpiresAtMs: now + refreshed.tokens.refreshTokenExpiresInSeconds * 1_000,
      scopes: refreshed.tokens.scopes,
      pendingRefresh: true,
      pendingInitial: undefined,
      refreshFailure: undefined,
    };
    pendingRefreshes.set(profileId, {
      record: rotatedRecord,
      accessToken: refreshed.tokens.accessToken,
    });
    try {
      await writeGitHubOAuthRecord(rotatedRecord);
    } catch {
      return;
    }
    pendingRefreshes.delete(profileId);
    await applyPendingRefresh(rotatedRecord, refreshed.tokens.accessToken);
  };

  const requestRefresh = (configured: ConfiguredOAuthIdentity): Promise<void> =>
    getOrCreatePromise(
      refreshes,
      configured.identity.profileId,
      () =>
        refreshOne(configured).catch((error: unknown) => {
          params.warn(`GitHub OAuth refresh failed; will retry: ${formatErrorMessage(error)}`);
        }),
      { evictOnSettled: true },
    );

  const reconcileRecords = async (): Promise<void> => {
    for (const { requestId, record } of await listGitHubDeviceAuthorizationRecords()) {
      if (!record || record.expiresAtMs <= Date.now()) {
        await queueDeviceCleanup(requestId);
      }
    }
    for (const { profileId, record } of await listGitHubOAuthRecords()) {
      if (!record) {
        await queueOAuthCleanup(profileId);
        continue;
      }
      if (record.pendingInitial) {
        if (committingRequests.has(record.pendingInitial.requestId)) {
          continue;
        }
        let persistedConfig: OpenClawConfig;
        try {
          const runtimeConfig = params.getConfig();
          const runtimeConfigValue = structuredClone(runtimeConfig);
          const persisted = await params.getPersistedConfig?.();
          if (!persisted) {
            continue;
          }
          await assertInitialRecordCurrent(record, runtimeConfig, runtimeConfigValue);
          if (committingRequests.has(record.pendingInitial.requestId)) {
            continue;
          }
          persistedConfig = persisted;
        } catch {
          continue;
        }
        const persistedIdentity = resolveConfiguredGitHubToolIdentity({
          config: persistedConfig,
          ...record,
        });
        const agentBindingMatches =
          record.scope === "system" ||
          (record.pendingInitial.agentLifecycleBinding !== undefined &&
            (await matchesAgentLifecycleBindingAsync(
              () => persistedConfig,
              record.pendingInitial.agentLifecycleBinding,
            )));
        if (
          agentBindingMatches &&
          persistedIdentity?.profileId === profileId &&
          persistedIdentity.kind === "oauth"
        ) {
          await writeGitHubOAuthRecord({ ...record, pendingInitial: undefined });
          if (record.pendingInitial.expectedIdentity?.kind === "oauth") {
            await queueOAuthCleanup(record.pendingInitial.expectedIdentity.profileId);
          }
          continue;
        }
        await queueOAuthCleanup(profileId);
        await removeManagedGitHubProfile(
          resolveManagedGitHubProfileDir({
            agentId: record.agentId,
            scope: record.scope,
            profileId,
          }),
        ).catch(() => undefined);
        continue;
      }
      const current = resolveConfiguredGitHubToolIdentity({
        config: params.getConfig(),
        ...record,
      });
      if (current?.profileId !== profileId || current.kind !== "oauth") {
        await queueOAuthCleanup(profileId);
        continue;
      }
      if (record.pendingRefresh && !stopping) {
        await requestRefresh({
          scope: record.scope,
          agentId: record.agentId,
          identity: { ...current, kind: "oauth" },
        });
      }
    }
  };

  const runMaintenance = async (): Promise<void> => {
    for (const requestId of pendingCleanup) {
      await queueDeviceCleanup(requestId);
    }
    for (const [profileId, pending] of [...pendingRefreshes].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      try {
        await writeGitHubOAuthRecord(pending.record);
        pendingRefreshes.delete(profileId);
        await applyPendingRefresh(pending.record, pending.accessToken);
      } catch {
        // Retain the rotated refresh token in memory for the next maintenance pass.
      }
    }
    await reconcileRecords();
    for (const configured of configuredOAuthIdentities(params.getConfig())) {
      if (stopping) {
        break;
      }
      await requestRefresh(configured);
    }
  };

  const maintain = (): Promise<void> => {
    if (stopping && !maintenance) {
      return Promise.resolve();
    }
    maintenance ??= runMaintenance()
      .catch(warnMaintenanceError)
      .finally(() => {
        maintenance = undefined;
      });
    return maintenance;
  };

  return {
    personal,
    startAuthorization: async (input: {
      scope: GitHubIdentityScope;
      agentId: string;
    }): Promise<ToolsGitHubAuthorizeStartResult> => {
      if (stopping) {
        throw new Error("GitHub authorization lifecycle is stopping.");
      }
      assertGitHubCliAvailable();
      const expectedIdentity = structuredClone(
        resolveConfiguredGitHubToolIdentity({ config: params.getConfig(), ...input }) ?? null,
      );
      const agentLifecycleBinding =
        input.scope === "agent"
          ? await captureAgentLifecycleBinding(params.getConfig, input.agentId)
          : undefined;
      if (input.scope === "agent" && !agentLifecycleBinding) {
        throw new Error("GitHub authorization requires an active agent.");
      }
      if (!identityStillSelected(params.getConfig(), input, expectedIdentity)) {
        throw new Error("GitHub identity changed while authorization was starting.");
      }
      deviceController.signal.throwIfAborted();
      const authorization = await startGitHubDeviceFlow(deviceController.signal);
      if (
        !identityStillSelected(params.getConfig(), input, expectedIdentity) ||
        (agentLifecycleBinding !== undefined &&
          !(await matchesAgentLifecycleBindingAsync(params.getConfig, agentLifecycleBinding)))
      ) {
        throw new Error("GitHub identity changed while authorization was starting.");
      }
      for (const existing of await listGitHubDeviceAuthorizationRecords()) {
        if (existing.record?.scope === input.scope && existing.record.agentId === input.agentId) {
          await queueDeviceCleanup(existing.requestId);
        }
      }
      const requestId = `github-device-${randomBytes(16).toString("hex")}`;
      await writeGitHubDeviceAuthorizationRecord({
        version: 1,
        requestId,
        ...authorization,
        agentId: input.agentId,
        scope: input.scope,
        expectedIdentity,
        ...(agentLifecycleBinding ? { agentLifecycleBinding } : {}),
      });
      return {
        requestId,
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresInMs: Math.max(0, authorization.expiresAtMs - Date.now()),
        pollAfterMs: authorization.pollIntervalMs,
      };
    },
    pollAuthorization: (requestId: string): Promise<ToolsGitHubAuthorizePollResult> =>
      getOrCreatePromise(devicePolls, requestId, () => pollOnce(requestId), {
        evictOnSettled: true,
      }),
    /** @deprecated Use cancelAuthorizationAsync; removed in the next Plugin SDK major. */
    cancelAuthorization(requestId: string): boolean {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "cancelAuthorization",
        replacement: "cancelAuthorizationAsync",
      });
      if (committingRequests.has(requestId)) {
        return false;
      }
      const existed = readGitHubDeviceAuthorizationRecordNative(requestId) !== undefined;
      try {
        deleteGitHubDeviceAuthorizationRecordNative(requestId);
        pendingCleanup.delete(requestId);
      } catch {
        pendingCleanup.add(requestId);
      }
      return existed;
    },
    cancelAuthorizationAsync: async (requestId: string): Promise<boolean> => {
      const existed = (await readGitHubDeviceAuthorizationRecord(requestId)) !== undefined;
      if (committingRequests.has(requestId)) {
        return false;
      }
      await queueDeviceCleanup(requestId);
      return existed;
    },
    status,
    /** @deprecated Use retireProfileAsync; removed in the next Plugin SDK major. */
    retireProfile(profileId: string): void {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "retireProfile",
        replacement: "retireProfileAsync",
      });
      clearNativeGitHubTokenCache();
      try {
        deleteGitHubOAuthRecordNative(profileId);
      } catch {
        // Orphan cleanup retries on its next scheduled scan.
      }
    },
    retireProfileAsync: queueOAuthCleanup,
    refreshEffectiveIdentity: async (agentId: string): Promise<void> => {
      if (stopping) {
        return;
      }
      const config = params.getConfig();
      const agent = resolveAgentConfig(config, agentId)?.tools?.github;
      const identity = agent ?? config.tools?.github;
      if (identity?.kind !== "oauth") {
        return;
      }
      await requestRefresh({
        scope: agent ? "agent" : "system",
        agentId,
        identity: { ...identity, kind: "oauth" },
      });
    },
    maintain: async () => {
      await Promise.all([maintain(), personal.maintain()]).catch(warnMaintenanceError);
    },
    start: () => {
      if (stopping || maintenanceScope) {
        return;
      }
      const scheduler = params.scheduler.scope();
      maintenanceScope = scheduler;
      // Personal file cleanup must not delay System/agent refresh.
      scheduler.schedule({
        id: "maintenance:github-oauth",
        delayMs: 0,
        everyMs: MAINTENANCE_INTERVAL_MS,
        run: maintain,
      });
      scheduler.schedule({
        id: "maintenance:github-personal-oauth",
        delayMs: 0,
        everyMs: MAINTENANCE_INTERVAL_MS,
        run: () => personal.maintain().catch(warnMaintenanceError),
      });
    },
    stop: async () => {
      clearGitHubCredentialVerificationCache();
      stopping = true;
      maintenanceScope?.beginClose();
      deviceController.abort();
      const drain = (async () => {
        await Promise.allSettled([
          personal.stop(),
          maintenanceScope?.stop(),
          maintenance,
          ...devicePolls.values(),
          ...refreshes.values(),
        ]);
        if (pendingRefreshes.size > 0) {
          await runMaintenance();
        }
      })();
      await settlesWithin(drain, SHUTDOWN_DRAIN_TIMEOUT_MS);
    },
  };
}
