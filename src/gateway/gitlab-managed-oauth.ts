import { isDeepStrictEqual } from "node:util";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../agents/agent-lifecycle-registry.js";
import { validateGitLabOAuthConfig } from "../agents/gitlab-host.js";
import {
  consumeGitLabManagedSetupRecord,
  createManagedGitLabSetupRequestId,
  deleteGitLabManagedSetupRecord,
  listGitLabManagedOAuthRecords,
  listGitLabManagedSetupRecords,
  readGitLabManagedSetupRecord,
  writeGitLabManagedSetupRecord,
  type GitLabManagedSetupRecord,
} from "../agents/gitlab-managed-records.js";
import {
  createGitLabAuthorization,
  exchangeGitLabAuthorization,
  verifyGitLabAccount,
} from "../agents/gitlab-oauth-client.js";
import {
  finishPendingManagedGitLabProfile,
  installManagedGitLabProfile,
  removeManagedGitLabProfile,
  resolveConfiguredGitLabToolIdentity,
  resolveGitLabToolIdentityStatus,
} from "../agents/gitlab-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseGitLabOAuthCallback } from "../shared/gitlab-oauth-callback.js";
import { fingerprintGitLabOAuthConfig } from "./gitlab-oauth-config-fingerprint.js";
import { updateGitLabToolIdentityConfig } from "./gitlab-tool-identity-config.js";
import type { PersonalForgeAction } from "./server-methods/personal-forge-authorization.js";

type Target = { scope: "system" | "agent"; agentId: string };
type Active = Target & {
  initiator: string;
  controller: AbortController;
  committing: boolean;
};
const targetKey = (target: Target) =>
  target.scope === "system" ? "system" : `agent:${target.agentId}`;

/** Native managed setup has its own target and administrator, separate from user grants. */
export function createManagedGitLabOAuthLifecycle(params: {
  getConfig: () => OpenClawConfig;
  getPersistedConfig: () => Promise<OpenClawConfig>;
}) {
  const lifetime = new AbortController();
  const active = new Map<string, Active>();
  const pending = new Set<Promise<unknown>>();
  let reconciliation: Promise<void> | undefined;
  const configuration = () => {
    const config = params.getConfig().gateway?.gitlab;
    if (!config) {
      throw new Error("GitLab connections are not configured.");
    }
    return validateGitLabOAuthConfig(config);
  };
  const tracked = async <T>(run: () => Promise<T>): Promise<T> => {
    lifetime.signal.throwIfAborted();
    const operation = run();
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  };
  const profileSelected = (config: OpenClawConfig, profileId: string) =>
    config.tools?.gitlab?.profileId === profileId ||
    Object.values(config.agents?.entries ?? {}).some(
      (entry) => entry.tools?.gitlab?.profileId === profileId,
    );
  const reconcile = () => {
    if (reconciliation) {
      return reconciliation;
    }
    const operation = (async () => {
      // A committed selector is durable acceptance. Settle only its exact inactive record.
      for (const { record } of await listGitLabManagedOAuthRecords()) {
        lifetime.signal.throwIfAborted();
        if (!record) {
          continue;
        }
        const config = params.getConfig();
        const persisted = await params.getPersistedConfig();
        if (
          !profileSelected(config, record.profileId) &&
          !profileSelected(persisted, record.profileId)
        ) {
          // An in-flight install owns its inactive record until its config CAS settles.
          if (record.pendingInitial && active.has(record.pendingInitial.requestId)) {
            continue;
          }
          // Revocation commits before cleanup. Retry orphan cleanup after runtime reload,
          // checking both persisted and live selectors before each destructive step.
          const assertUnselected = async () => {
            lifetime.signal.throwIfAborted();
            const latestPersisted = await params.getPersistedConfig();
            if (
              profileSelected(latestPersisted, record.profileId) ||
              profileSelected(params.getConfig(), record.profileId)
            ) {
              throw new Error("Managed GitLab profile is still selected.");
            }
          };
          try {
            await removeManagedGitLabProfile({
              scope: record.scope,
              agentId: record.agentId,
              profileId: record.profileId,
              getCurrentConfig: params.getConfig,
              assertCurrent: assertUnselected,
            });
          } catch {
            lifetime.signal.throwIfAborted();
            // A selected profile or an I/O failure remains intact for the next reconciliation.
          }
          continue;
        }
        if (!record.pendingInitial) {
          continue;
        }
        const selected = resolveConfiguredGitLabToolIdentity({
          config,
          scope: record.scope,
          agentId: record.agentId,
        });
        if (selected?.profileId !== record.profileId || selected.issuer !== record.issuer) {
          continue;
        }
        try {
          await finishPendingManagedGitLabProfile({
            getCurrentConfig: params.getConfig,
            scope: record.scope,
            agentId: record.agentId,
            profileId: record.profileId,
            assertCurrent: () => lifetime.signal.throwIfAborted(),
          });
        } catch {
          lifetime.signal.throwIfAborted();
          // Unsettled or replaced targets remain unavailable; another target may still reconnect.
        }
      }
    })();
    reconciliation = operation;
    void operation
      .finally(() => {
        if (reconciliation === operation) {
          reconciliation = undefined;
        }
      })
      .catch(() => {});
    return operation;
  };
  const assertRecord = async (
    action: PersonalForgeAction,
    record: GitLabManagedSetupRecord,
    signal: AbortSignal,
    selected = true,
  ) => {
    action.assertCurrent();
    signal.throwIfAborted();
    if (
      record.initiatorProfileId !== action.owner ||
      record.expiresAtMs <= Date.now() ||
      record.configFingerprint !== fingerprintGitLabOAuthConfig(configuration()) ||
      record.issuer !== configuration().issuer
    ) {
      throw new Error("GitLab authorization changed or expired; start again.");
    }
    if (
      record.scope === "agent" &&
      (!record.agentLifecycleBinding ||
        !(await matchesAgentLifecycleBindingAsync(params.getConfig, record.agentLifecycleBinding)))
    ) {
      throw new Error("Agent changed while GitLab setup was in progress.");
    }
    if (selected) {
      const config = await params.getPersistedConfig();
      if (
        !isDeepStrictEqual(
          resolveConfiguredGitLabToolIdentity({
            config,
            scope: record.scope,
            agentId: record.agentId,
          }) ?? null,
          record.expectedIdentity,
        )
      ) {
        throw new Error("GitLab selection changed while setup was in progress.");
      }
    }
    action.assertCurrent();
    signal.throwIfAborted();
  };
  return {
    reconcile: () => tracked(reconcile),
    status: (target: Target, assertCurrent?: () => void) =>
      tracked(async () => {
        await reconcile();
        assertCurrent?.();
        const config = params.getConfig();
        const oauth = configuration();
        const status = await resolveGitLabToolIdentityStatus({
          config,
          getCurrentConfig: params.getConfig,
          agentId: target.agentId,
          selectedScope: target.scope,
          oauthConfig: oauth,
          assertCurrent,
        });
        const effectiveScope = status.effectiveSource === "agent-override" ? "agent" : "system";
        const effectiveStatus =
          status.effectiveSource === "unavailable"
            ? null
            : effectiveScope === target.scope
              ? status
              : await resolveGitLabToolIdentityStatus({
                  config,
                  getCurrentConfig: params.getConfig,
                  agentId: target.agentId,
                  selectedScope: effectiveScope,
                  oauthConfig: oauth,
                  assertCurrent,
                });
        return { issuer: oauth.issuer, ...status, effective: effectiveStatus?.selected ?? null };
      }),
    start: (action: PersonalForgeAction, target: Target) =>
      tracked(async () => {
        await reconcile();
        action.assertCurrent();
        const oauthConfig = configuration();
        const expectedIdentity =
          resolveConfiguredGitLabToolIdentity({
            config: await params.getPersistedConfig(),
            ...target,
          }) ?? null;
        const binding =
          target.scope === "agent"
            ? await captureAgentLifecycleBinding(params.getConfig, target.agentId)
            : undefined;
        if (target.scope === "agent" && !binding) {
          throw new Error("GitLab setup requires an active agent.");
        }
        const requestId = createManagedGitLabSetupRequestId();
        const authorization = createGitLabAuthorization(oauthConfig);
        const state = `gitlab-managed.${requestId}.${authorization.state}`;
        const url = new URL(authorization.url);
        url.searchParams.set("state", state);
        const now = Date.now();
        const record: GitLabManagedSetupRecord = {
          version: 1,
          requestId,
          ...target,
          initiatorProfileId: action.owner,
          issuer: oauthConfig.issuer,
          configFingerprint: fingerprintGitLabOAuthConfig(oauthConfig),
          expectedIdentity,
          ...(binding ? { agentLifecycleBinding: binding } : {}),
          state,
          verifier: authorization.verifier,
          createdAtMs: now,
          expiresAtMs: now + 10 * 60_000,
        };
        const signal = AbortSignal.any([action.signal, lifetime.signal]);
        await assertRecord(action, record, signal);
        for (const current of active.values()) {
          if (targetKey(current) !== targetKey(target)) {
            continue;
          }
          if (current.committing) {
            throw new Error("GitLab connection activation is already in progress.");
          }
          current.controller.abort();
        }
        for (const prior of await listGitLabManagedSetupRecords()) {
          if (targetKey(prior) === targetKey(target)) {
            await deleteGitLabManagedSetupRecord({
              requestId: prior.requestId,
              initiatorProfileId: prior.initiatorProfileId,
            });
          }
        }
        await assertRecord(action, record, signal);
        await writeGitLabManagedSetupRecord(record);
        await assertRecord(action, record, signal);
        return { requestId, authorizationUrl: url.toString(), expiresAtMs: record.expiresAtMs };
      }),
    complete: (action: PersonalForgeAction, requestId: string, callbackUrl: string) =>
      tracked(async () => {
        await reconcile();
        const config = configuration();
        const callback = parseGitLabOAuthCallback(config.redirectUri, callbackUrl);
        const record = await readGitLabManagedSetupRecord(requestId);
        if (
          !record ||
          record.initiatorProfileId !== action.owner ||
          record.state !== callback.state ||
          active.has(requestId)
        ) {
          throw new Error("GitLab authorization changed or expired; start again.");
        }
        const operation: Active = {
          scope: record.scope,
          agentId: record.agentId,
          initiator: action.owner,
          controller: new AbortController(),
          committing: false,
        };
        active.set(requestId, operation);
        const signal = AbortSignal.any([
          action.signal,
          lifetime.signal,
          operation.controller.signal,
        ]);
        const assertOwner = () => assertRecord(action, record, signal, false);
        try {
          await assertRecord(action, record, signal);
          await consumeGitLabManagedSetupRecord({
            requestId,
            state: callback.state,
            initiatorProfileId: action.owner,
          });
          await assertRecord(action, record, signal);
          const tokens = await exchangeGitLabAuthorization(config, {
            code: callback.code,
            verifier: record.verifier,
            signal,
            assertCurrent: () => assertRecord(action, record, signal),
          });
          const account = await verifyGitLabAccount(config, tokens, {
            signal,
            allowBot: true,
            assertCurrent: () => assertRecord(action, record, signal),
          });
          await assertRecord(action, record, signal);
          let nextConfig: OpenClawConfig | undefined;
          await installManagedGitLabProfile({
            scope: record.scope,
            agentId: record.agentId,
            account,
            tokens,
            oauthConfig: config,
            requestId,
            expectedIdentity: record.expectedIdentity,
            agentLifecycleBinding: record.agentLifecycleBinding,
            assertCurrent: assertOwner,
            commitConfig: async (identity) => {
              operation.committing = true;
              nextConfig = await updateGitLabToolIdentityConfig({
                scope: record.scope,
                agentId: record.agentId,
                identity,
                expectedIdentity: record.expectedIdentity,
                agentLifecycleBinding: record.agentLifecycleBinding,
                assertCurrent: assertOwner,
              });
            },
          });
          await assertOwner();
          if (record.expectedIdentity) {
            try {
              await removeManagedGitLabProfile({
                scope: record.scope,
                agentId: record.agentId,
                profileId: record.expectedIdentity.profileId,
                getCurrentConfig: params.getConfig,
                assertCurrent: assertOwner,
              });
            } catch {
              // Runtime reload may still hold the old selector. Never delete a referenced profile.
            }
          }
          return {
            connected: true,
            scope: record.scope,
            agentId: record.agentId,
            account: { accountId: account.accountId, login: account.login },
            configCommitted: Boolean(nextConfig),
          };
        } finally {
          active.delete(requestId);
        }
      }),
    cancel: (action: PersonalForgeAction, requestId: string) =>
      tracked(async () => {
        action.assertCurrent();
        const current = active.get(requestId);
        if (current) {
          if (current.initiator !== action.owner) {
            throw new Error("GitLab setup belongs to another administrator.");
          }
          if (current.committing) {
            return { cancelled: false };
          }
          current.controller.abort();
        }
        const record = await readGitLabManagedSetupRecord(requestId);
        if (record && record.initiatorProfileId !== action.owner) {
          throw new Error("GitLab setup belongs to another administrator.");
        }
        action.assertCurrent();
        if (record) {
          await deleteGitLabManagedSetupRecord({ requestId, initiatorProfileId: action.owner });
        }
        return { cancelled: Boolean(record || current) };
      }),
    async stop() {
      lifetime.abort();
      for (const operation of active.values()) {
        operation.controller.abort();
      }
      await Promise.allSettled([...pending, ...(reconciliation ? [reconciliation] : [])]);
    },
  };
}
