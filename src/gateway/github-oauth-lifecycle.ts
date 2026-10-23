import { randomBytes, randomUUID } from "node:crypto";
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
import {
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "../agents/github-tool-identity.js";
import { registerRuntimeConfigWriteListener } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { isRecoverableOAuthRefreshFailure } from "../shared/oauth-refresh-outcome.js";
import { settlesWithin } from "../shared/settle-within.js";
import { assertGitHubCliAvailable } from "./github-cli-preflight.js";
import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from "./github-oauth-device-flow.js";
import {
  assertInitialOAuthRecordCurrent,
  assertGitHubOAuthIdentitySelected,
  applyPendingGitHubOAuthRefresh,
  settleGitHubOAuthRefreshRecord,
  authorizationStillOwned,
  authorizationStillOwnedAsync,
  configuredOAuthIdentities,
  captureGitHubOAuthAuthorizationIdentity,
  createGitHubOAuthInventoryReader,
  identityStillSelected,
  MAINTENANCE_INTERVAL_MS,
  nextGitHubOAuthMaintenanceAtMs,
  pendingInitialOAuthIdentitySelected,
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
    {
      record: GitHubOAuthRecord & { pendingRefresh: true };
      expected: GitHubOAuthRecord;
      accessToken: string;
    }
  >();
  const pendingCleanup = new Set<string>();
  let maintenance: Promise<void> | undefined;
  let maintenanceScope: GatewaySchedulerScope | undefined;
  let stopping = false;
  let nextMaintenanceAtMs = Number.POSITIVE_INFINITY;
  const oauthInventory = createGitHubOAuthInventoryReader(() => {
    scheduleMaintenance(Date.now() + MAINTENANCE_INTERVAL_MS);
  });
  const unsubscribeConfig = registerRuntimeConfigWriteListener(() => {
    scheduleMaintenance(Date.now());
  });
  function scheduleMaintenance(atMs: number) {
    if (!stopping && Number.isFinite(atMs)) {
      maintenanceScope?.schedule({
        id: "maintenance:github-oauth",
        atMs,
        mode: "earliest",
        run: maintain,
      });
    }
  }
  const warnMaintenanceError = (error: unknown) =>
    params.warn(`GitHub OAuth maintenance failed; will retry: ${formatErrorMessage(error)}`);

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
      // The failed deletion invalidates inventory for the next retry.
    }
  };

  const status = (agentId: string, selectedScope: GitHubIdentityScope) =>
    resolveGitHubToolIdentityStatus({ config: params.getConfig(), agentId, selectedScope });

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
          await assertInitialOAuthRecordCurrent(
            params.getConfig,
            initialRecord,
            runtimeConfig,
            runtimeConfigValue,
          );
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
    if (!(await authorizationStillOwnedAsync(params.getConfig, record))) {
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

  const refreshOne = async (configured: ConfiguredOAuthIdentity): Promise<void> => {
    const profileId = configured.identity.profileId;
    const inspected = await inspectGitHubOAuthRecord(profileId);
    if (inspected.state !== "valid") {
      return;
    }
    const currentRecord = inspected.record;
    if (currentRecord.pendingInitial || currentRecord.refreshClaim) {
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
    const claimedRecord: GitHubOAuthRecord = { ...currentRecord, refreshClaim: randomUUID() };
    await settleGitHubOAuthRefreshRecord(claimedRecord, currentRecord);
    let refreshed;
    try {
      refreshed = await refreshGitHubOAuthToken({
        refreshToken: currentRecord.refreshToken,
        assertCurrent: async () => {
          const current = await inspectGitHubOAuthRecord(profileId);
          assertGitHubOAuthIdentitySelected(params.getConfig, currentRecord);
          if (current.state !== "valid" || !isDeepStrictEqual(current.record, claimedRecord)) {
            throw new Error("GitHub OAuth refresh ownership changed before dispatch.");
          }
        },
      });
    } catch (error) {
      await settleGitHubOAuthRefreshRecord(
        {
          ...claimedRecord,
          pendingRefresh: undefined,
          refreshFailure: "failed",
          ...(isRecoverableOAuthRefreshFailure(error) ? { refreshClaim: undefined } : {}),
        },
        claimedRecord,
      );
      return;
    }
    if (refreshed.status === "error") {
      const refreshFailure = refreshed.code === "bad_refresh_token" ? "expired" : "failed";
      await settleGitHubOAuthRefreshRecord(
        {
          ...claimedRecord,
          pendingRefresh: undefined,
          refreshFailure,
          ...(isRecoverableOAuthRefreshFailure(refreshed.failure)
            ? { refreshClaim: undefined }
            : {}),
        },
        claimedRecord,
      );
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
      expected: claimedRecord,
      accessToken: refreshed.tokens.accessToken,
    });
    try {
      await settleGitHubOAuthRefreshRecord(rotatedRecord, claimedRecord);
    } catch {
      return;
    }
    pendingRefreshes.delete(profileId);
    await applyPendingGitHubOAuthRefresh(
      params.getConfig,
      rotatedRecord,
      refreshed.tokens.accessToken,
    );
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
    const inventory = await oauthInventory.read();
    const { deviceRecords, oauthRecords } = inventory;
    nextMaintenanceAtMs = nextGitHubOAuthMaintenanceAtMs(inventory, Date.now());
    for (const { requestId, record } of deviceRecords) {
      if (!record || record.expiresAtMs <= Date.now()) {
        await queueDeviceCleanup(requestId);
      }
    }
    for (const { profileId, record } of oauthRecords) {
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
          await assertInitialOAuthRecordCurrent(
            params.getConfig,
            record,
            runtimeConfig,
            runtimeConfigValue,
          );
          if (committingRequests.has(record.pendingInitial.requestId)) {
            continue;
          }
          persistedConfig = persisted;
        } catch {
          continue;
        }
        if (await pendingInitialOAuthIdentitySelected(persistedConfig, record)) {
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
        await settleGitHubOAuthRefreshRecord(pending.record, pending.expected);
        pendingRefreshes.delete(profileId);
        await applyPendingGitHubOAuthRefresh(params.getConfig, pending.record, pending.accessToken);
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
      .catch((error: unknown) => {
        nextMaintenanceAtMs = Date.now() + MAINTENANCE_INTERVAL_MS;
        warnMaintenanceError(error);
      })
      .finally(() => {
        maintenance = undefined;
        if (oauthInventory.dirty || pendingCleanup.size > 0 || pendingRefreshes.size > 0) {
          nextMaintenanceAtMs = Math.min(nextMaintenanceAtMs, Date.now() + MAINTENANCE_INTERVAL_MS);
        }
        scheduleMaintenance(Math.max(Date.now() + 1, nextMaintenanceAtMs));
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
      const expectedIdentity = captureGitHubOAuthAuthorizationIdentity(params.getConfig(), input);
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
    /** @deprecated Use cancelAuthorizationAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
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
    /** @deprecated Use retireProfileAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
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
      maintenanceScope = params.scheduler.scope();
      // Personal file cleanup must not delay System/agent refresh.
      scheduleMaintenance(Date.now());
      maintenanceScope.schedule({
        id: "maintenance:github-personal-oauth",
        delayMs: 0,
        everyMs: MAINTENANCE_INTERVAL_MS,
        run: () => personal.maintain().catch(warnMaintenanceError),
      });
    },
    stop: async () => {
      clearGitHubCredentialVerificationCache();
      stopping = true;
      oauthInventory.close();
      unsubscribeConfig();
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
