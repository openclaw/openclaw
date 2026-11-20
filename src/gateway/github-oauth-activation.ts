import { isDeepStrictEqual } from "node:util";
import type { ToolsGitHubAuthorizePollResult } from "../../packages/gateway-protocol/src/index.js";
import type { GitHubOAuthTokenPair } from "../agents/github-oauth-client.js";
import {
  createGitHubOAuthRecord,
  inspectGitHubOAuthRecord,
  readGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
  type GitHubDeviceAuthorizationRecord,
  type GitHubOAuthRecord,
} from "../agents/github-oauth-records.js";
import {
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "../agents/github-tool-identity.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import {
  assertInitialOAuthRecordCurrent,
  authorizationStillOwned,
  authorizationStillOwnedAsync,
  identityStillSelected,
} from "./github-oauth-lifecycle-helpers.js";
import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";

export function createGitHubOAuthActivation(params: {
  getConfig: () => OpenClawConfig;
  getPersistedConfig?: () => Promise<OpenClawConfig>;
  queueDeviceCleanup: (requestId: string) => Promise<void>;
  queueOAuthCleanup: (profileId: string) => Promise<void>;
  committingRequests: Set<string>;
}) {
  const { queueDeviceCleanup, queueOAuthCleanup, committingRequests } = params;
  return async (
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
    const application = createRuntimeConfigWriteApplication(
      captureGatewayRootWorkAdmissionContinuationScope()?.run,
    );
    const completeAuthorization = async (
      config: OpenClawConfig,
    ): Promise<ToolsGitHubAuthorizePollResult> => {
      const applied = application.claimed ? await application.result : "unclaimed";
      const identity = resolveConfiguredGitHubToolIdentity({ config, ...record });
      // A durable save can precede reload or survive a disabled reload. Keep both
      // credentials until the runtime actually selects the complete candidate.
      if (
        (applied !== "applied" &&
          applied !== "applied-restart-required" &&
          applied !== "unclaimed") ||
        identity?.profileId !== profileId ||
        !identityStillSelected(
          params.getConfig(),
          { ...record, expectedPathPrepend: record.activation?.pathPrepend },
          identity,
        )
      ) {
        await queueDeviceCleanup(record.requestId);
        return { status: "failed", reason: "config_not_applied" };
      }
      const inspected = await inspectGitHubOAuthRecord(profileId);
      if (inspected.state !== "valid") {
        throw new Error("GitHub OAuth initial record is unavailable.");
      }
      if (inspected.record.pendingInitial) {
        const { pendingInitial: _pendingInitial, ...settledRecord } = inspected.record;
        await writeGitHubOAuthRecord(settledRecord);
        initialRecord = settledRecord;
      }
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
          if (record.activation && account.accountId !== record.activation.expectedAccountId) {
            throw new Error("GitHub authorization selected a different account.");
          }
          const pending = await readGitHubDeviceAuthorizationRecord(record.requestId);
          if (
            !pending ||
            pending.createdAtMs !== record.createdAtMs ||
            pending.deviceCode !== record.deviceCode ||
            !isDeepStrictEqual(pending.expectedIdentity, record.expectedIdentity) ||
            !isDeepStrictEqual(pending.activation, record.activation) ||
            !isDeepStrictEqual(pending.expectedPathPrepend, record.expectedPathPrepend) ||
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
            gitAuthor:
              !record.activation?.resetGitAuthor && record.expectedIdentity?.gitAuthor
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
            writeOptions: attachRuntimeConfigWriteApplication({}, application),
            pathPrepend: record.activation?.pathPrepend
              ? {
                  expected: record.expectedPathPrepend ?? null,
                  value: record.activation.pathPrepend,
                }
              : undefined,
            ...(record.agentLifecycleBinding
              ? { agentLifecycleBinding: record.agentLifecycleBinding }
              : {}),
          });
        },
      });
      return await completeAuthorization(nextConfig);
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
  };
}
