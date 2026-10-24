import { isDeepStrictEqual } from "node:util";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../agents/conversation-tool-policy-pipeline.js";
import { prepareExecDefaults, resolveExecConfigState } from "../agents/exec-defaults.js";
import { captureSandboxConfig, resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxContextForPersistentExecution } from "../agents/sandbox/context.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { captureCronStreamSandboxTarget } from "../agents/sandbox/stream-context.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { resolveScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import type { SessionSharingEntry } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { parseCronStreamSandboxTarget } from "../cron/stream-sandbox-target.js";
import type { CronStoredJob } from "../cron/types.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  hasOnlySessionMutationKindActive,
  isSessionMutationActive,
} from "../sessions/session-controller.lifecycle.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveCronSkillsSnapshot } from "../skills/runtime/cron-snapshot.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { resumeGatewayOperatorAccessGrant } from "./operator-access-policy.js";
import {
  onOperatorRolePolicyChanged,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  authorizePreparedSessionMutation,
  type PreparedSessionMutationFacts,
} from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "./session-sharing-preparation.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";

type PreparedProfile = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
type PreparedSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

class PolicySessionReadRequired extends Error {
  constructor(readonly sessionKey: string) {
    super("Sandbox stream policy requires current related session facts.");
  }
}

/** Restore the recorded sandbox and original access dependency for one live stream owner. */
export async function prepareCronStreamSandboxAuthority(params: {
  job: CronStoredJob;
  getRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<{
  sandbox: SandboxContext;
  assertCurrent: () => void;
  signal: AbortSignal;
  release: () => void;
}> {
  const target = parseCronStreamSandboxTarget(params.job.streamSandbox);
  if (!target || params.job.schedule.kind !== "stream") {
    throw new Error("Persistent sandbox stream target is unavailable; recreate this automation.");
  }
  const selections = structuredClone(params.job.skillLibrarySelections);
  const config = params.getRuntimeConfig();
  const sandboxConfig = captureSandboxConfig(resolveSandboxConfigForAgent(config, target.agentId));
  const configuredWorkspace = resolveAgentWorkspaceDir(config, target.agentId);
  const operator = target.operator;
  const originalRole = operator
    ? structuredClone(
        sourceRolePolicy(
          resolveOperatorRolePolicyForAssignment(
            operator.profileId,
            operator.assignedRole,
            config,
            operator.githubLogin,
          ),
        ),
      )
    : undefined;
  const client = operator
    ? createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "operator", profileId: operator.profileId },
        scopes: [...operator.scopes],
      })
    : undefined;
  const revoked = new AbortController();
  const subscriptions: Array<() => void> = [];
  let profile: PreparedProfile | undefined;
  let emailBindingIds: readonly string[] | undefined;
  let session: PreparedSession | undefined;
  const policySessions = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
  let policyPrepared = false;
  let access: PluginGatewayAccessAuthority | null | undefined;
  let runtime: ReturnType<typeof resolveSandboxRuntimeStatus> | undefined;
  let references = 1;
  let released = false;
  let disposeSandbox: (() => void) | undefined;
  const unavailable = () =>
    new Error(
      "Sandbox stream authority changed; recreate this automation from the current session.",
    );
  const revoke = (error: unknown) => revoked.abort(error);
  const dropReference = () => {
    if (--references === 0) {
      for (const unsubscribe of subscriptions.splice(0).toReversed()) {
        unsubscribe();
      }
      session?.release();
      for (const related of policySessions.values()) {
        related.release();
      }
      profile?.release();
    }
  };
  const release = () => {
    if (!released) {
      released = true;
      revoke(unavailable());
      dropReference();
      disposeSandbox?.();
    }
  };
  const assertExecutionPolicy = (
    currentConfig: OpenClawConfig,
    entry: SessionSharingEntry,
    currentRuntime: ReturnType<typeof resolveSandboxRuntimeStatus>,
  ) => {
    const execParams = {
      cfg: currentConfig,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      sessionEntry: entry,
      sandboxAvailable: true,
    };
    const defaults = prepareExecDefaults(execParams, currentRuntime);
    const { globalExec, agentExec } = resolveExecConfigState(execParams);
    const policy = projectEffectiveExecPolicy({
      base: applyExecPolicyLayer(globalExec ?? {}, agentExec),
      permissionPolicy: entry.permissionMode ? { mode: entry.permissionMode } : undefined,
    });
    // Saved consent covers asks for this exact stream; it never overrides current denial or placement.
    if (
      defaults.kind !== "resolved" ||
      defaults.defaults.effectiveHost !== "sandbox" ||
      policy.mode === "deny" ||
      policy.security === "deny"
    ) {
      throw unavailable();
    }
    // Native locked model ownership needs the same retained projection as session resource policy.
    if (entry.modelSelectionLocked) {
      throw unavailable();
    }
    const readEntry = (key: string) => {
      if (key === target.sessionKey) {
        return entry;
      }
      const related = policySessions.get(key);
      if (!related) {
        throw new PolicySessionReadRequired(key);
      }
      return related.readCurrent(currentConfig).target?.entry;
    };
    const metadata = getGatewayPluginMetadataSnapshot();
    const model = resolveSessionSelectedModelRef({
      cfg: currentConfig,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      source: { entry, readSourceEntry: readEntry },
      manifestPlugins: metadata ?? [],
    });
    const scheduledToolPolicy = resolveScheduledToolPolicyContext({
      toolsAllow: params.job.payload.toolsAllow,
      scheduledToolPolicy: resolveCronScheduledToolPolicy({
        toolsAllow: params.job.payload.toolsAllow,
        scheduledToolPolicy: params.job.scheduledToolPolicy,
        owner: params.job.owner,
      }),
      callerOrigin: params.job.toolsAllowProvenance?.callerOrigin,
    });
    const capability = resolveConversationCapabilityProfile({
      config: currentConfig,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      sessionId: entry.sessionId,
      spawnedBy: entry.spawnedBy,
      preparedSessionEntry: { sessionKey: target.sessionKey, entry },
      preparedSessionCapabilityStore: {
        authoritative: true,
        get: readEntry,
        getById: () => undefined,
      },
      modelProvider: model.provider,
      modelId: model.model,
      pluginMetadataSnapshot: metadata,
      sandboxToolPolicy: currentRuntime.toolPolicy,
      scheduledToolPolicy,
    });
    if (!isConversationToolAllowed(capability, "exec")) {
      throw unavailable();
    }
  };
  const assertPreparedCurrent = () => {
    revoked.signal.throwIfAborted();
    params.signal?.throwIfAborted();
    params.assertCurrent();
    const currentConfig = params.getRuntimeConfig();
    if (
      !listAgentIds(currentConfig).includes(target.agentId) ||
      !isDeepStrictEqual(
        resolveSandboxConfigForAgent(currentConfig, target.agentId),
        sandboxConfig,
      ) ||
      resolveAgentWorkspaceDir(currentConfig, target.agentId) !== configuredWorkspace
    ) {
      throw unavailable();
    }
    const identity = profile?.readCurrentFacts(emailBindingIds);
    const role = operator
      ? resolveOperatorRolePolicyForAssignment(
          operator.profileId,
          operator.assignedRole,
          currentConfig,
          identity ? (identity.profile.githubLogin ?? null) : operator.githubLogin,
        )
      : undefined;
    if (operator) {
      if (
        (profile &&
          (identity?.profile.profileId !== operator.profileId ||
            identity.profile.assignedRole !== operator.assignedRole ||
            (identity.profile.githubLogin ?? null) !== operator.githubLogin)) ||
        !isDeepStrictEqual(sourceRolePolicy(role), originalRole) ||
        (role &&
          !roleScopesAllow({
            role: "operator",
            requestedScopes: operator.scopes,
            allowedScopes: role.scopes,
          }))
      ) {
        throw unavailable();
      }
    }
    const facts = session?.readCurrent(currentConfig);
    const entry = facts?.target.entry;
    if (
      session &&
      isSessionMutationActive(session.storageTarget.storePath, [
        target.sessionKey,
        target.sessionId,
      ]) &&
      !hasOnlySessionMutationKindActive(
        session.storageTarget.storePath,
        [target.sessionKey, target.sessionId],
        "compaction",
      ) &&
      !hasOnlySessionMutationKindActive(
        session.storageTarget.storePath,
        [target.sessionKey, target.sessionId],
        "read-marker",
      ) &&
      !hasOnlySessionMutationKindActive(
        session.storageTarget.storePath,
        [target.sessionKey, target.sessionId],
        "background-result",
      )
    ) {
      throw unavailable();
    }
    if (
      session &&
      (!entry ||
        entry.archivedAt !== undefined ||
        facts?.target.agentId !== target.agentId ||
        facts.target.canonicalKey !== target.sessionKey ||
        entry.sessionId !== target.sessionId ||
        entry.lifecycleRevision !== target.lifecycleRevision ||
        !isDeepStrictEqual(entry.skillLibrarySelections, selections))
    ) {
      throw unavailable();
    }
    if (
      facts &&
      client &&
      identity &&
      authorizePreparedSessionMutation(
        {
          cfg: currentConfig,
          client,
          agentId: target.agentId,
          sessionKey: target.sessionKey,
        },
        facts,
        { policy: role, aliases: identity.aliases },
      )
    ) {
      throw unavailable();
    }
    if (entry) {
      const currentRuntime = resolveSandboxRuntimeStatus({
        cfg: currentConfig,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        preparedSessionEntry: entry,
      });
      if (!currentRuntime.sandboxed || (runtime && !isDeepStrictEqual(currentRuntime, runtime))) {
        throw unavailable();
      }
      if (policyPrepared) {
        assertExecutionPolicy(currentConfig, entry, currentRuntime);
      }
    }
    return { currentConfig, identity, entry };
  };
  const assertAuthorityCurrent = () => {
    try {
      const current = assertPreparedCurrent();
      access?.signal.throwIfAborted();
      access?.assertCurrent();
      if (operator && current.identity) {
        resumeGatewayOperatorAccessGrant(
          current.identity.profile,
          current.currentConfig,
          operator.gatewayAccessGrant,
        );
      }
      // Plugin callbacks may synchronously publish role, profile, session, or config changes.
      assertPreparedCurrent();
    } catch (error) {
      revoke(error);
      throw error;
    }
  };
  const recheck = () => {
    try {
      assertPreparedCurrent();
      access?.signal.throwIfAborted();
      access?.assertCurrent();
    } catch (error) {
      revoke(error);
    }
  };
  const sourceAborted = () => revoke(params.signal?.reason ?? unavailable());
  subscriptions.push(
    onUserProfilesChanged(recheck),
    onOperatorRolePolicyChanged((change) => {
      if (change.kind === "assignment" && change.profileId === operator?.profileId) {
        revoke(unavailable());
      } else if (change.kind === "config") {
        recheck();
      }
    }),
    sessionChanges.subscribe((change) => {
      // Run projections do not change authority and can arrive before entry writes settle.
      if (
        ("sessionKey" in change && change.scope === "runtime") ||
        ("all" in change && change.scope === "agent-runs")
      ) {
        return;
      }
      if (
        "all" in change ||
        policySessions.has(change.sessionKey) ||
        (change.sessionKey === target.sessionKey &&
          (!change.agentId || change.agentId === target.agentId))
      ) {
        recheck();
      }
    }),
    onSessionIdentityMutation((change) => {
      if (
        change.agentId === target.agentId &&
        change.previous.sessionKeys.includes(target.sessionKey)
      ) {
        revoke(unavailable());
      }
    }),
  );
  params.signal?.addEventListener("abort", sourceAborted, { once: true });
  subscriptions.push(() => params.signal?.removeEventListener("abort", sourceAborted));
  try {
    assertAuthorityCurrent();
    if (operator) {
      profile = await prepareUserProfileIdentity(operator.profileId);
      emailBindingIds = profile.emailBindingIds;
      assertAuthorityCurrent();
    }
    session = await prepareSessionMutationFacts({
      cfg: config,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    const prepared = assertPreparedCurrent();
    if (!prepared.entry) {
      throw unavailable();
    }
    if (operator && prepared.identity) {
      access = resumeGatewayOperatorAccessGrant(
        prepared.identity.profile,
        prepared.currentConfig,
        operator.gatewayAccessGrant,
      );
      const originalAccess = access;
      const accessAborted = () => revoke(originalAccess?.signal.reason ?? unavailable());
      access?.signal.addEventListener("abort", accessAborted, { once: true });
      subscriptions.push(() => originalAccess?.signal.removeEventListener("abort", accessAborted));
    }
    assertAuthorityCurrent();
    runtime = resolveSandboxRuntimeStatus({
      cfg: prepared.currentConfig,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      preparedSessionEntry: prepared.entry,
    });
    // Discover only lineage requested by the canonical policy resolvers. Retained reads prevent
    // their synchronous lookup from opening SQLite or adopting a new parent after preparation.
    for (;;) {
      const current = assertPreparedCurrent();
      if (!current.entry) {
        throw unavailable();
      }
      try {
        assertExecutionPolicy(current.currentConfig, current.entry, runtime);
        policyPrepared = true;
        break;
      } catch (error) {
        if (!(error instanceof PolicySessionReadRequired) || policySessions.size >= 32) {
          throw error;
        }
        const related = await prepareSessionMutationFacts({
          cfg: current.currentConfig,
          agentId: parseAgentSessionKey(error.sessionKey)?.agentId ?? target.agentId,
          sessionKey: error.sessionKey,
          allowMissing: true,
        });
        policySessions.set(error.sessionKey, related);
        assertAuthorityCurrent();
      }
    }
    const authority = operator
      ? createAdmittedRunOperatorAuthority({
          profileId: operator.profileId,
          scopes: operator.scopes,
          gatewayAccessGrant: operator.gatewayAccessGrant,
          assertCurrent: assertAuthorityCurrent,
          signal: revoked.signal,
          readCurrentRoleFacts: () => ({
            assignedRole: operator.assignedRole,
            githubLogin: operator.githubLogin,
          }),
          ...(originalRole
            ? {
                rolePolicy: {
                  sessionAccessCap: originalRole.sessions.others,
                  sandboxRequired: originalRole.sandbox === "required",
                  agents: originalRole.agents,
                },
              }
            : {}),
          retain: () => {
            assertAuthorityCurrent();
            references += 1;
            let done = false;
            return () => {
              if (!done) {
                done = true;
                dropReference();
              }
            };
          },
        })
      : undefined;
    const skillsSnapshot = await resolveCronSkillsSnapshot({
      workspaceDir: target.agentWorkspaceDir,
      config: prepared.currentConfig,
      agentId: target.agentId,
      librarySelections: selections,
      isFastTestEnv: false,
    });
    assertAuthorityCurrent();
    const sandbox = await resolveSandboxContextForPersistentExecution(
      {
        config: prepared.currentConfig,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        ...(target.workspaceSource !== "managed-worktree"
          ? { workspaceDir: target.agentWorkspaceDir }
          : {}),
        skillsSnapshot,
        preparedRuntimeStatus: runtime,
        requireCurrentConfig: true,
        assertCurrent: assertAuthorityCurrent,
      },
      authority,
    );
    disposeSandbox = sandbox?.[Symbol.dispose]?.bind(sandbox);
    assertAuthorityCurrent();
    if (!sandbox) {
      throw unavailable();
    }
    const assertCurrent = () => {
      try {
        assertAuthorityCurrent();
        const current = assertPreparedCurrent();
        if (
          !current.entry ||
          !isDeepStrictEqual(
            captureCronStreamSandboxTarget({
              sandbox,
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              entry: current.entry,
            }),
            target,
          )
        ) {
          throw unavailable();
        }
        assertAuthorityCurrent();
      } catch (error) {
        revoke(error);
        throw error;
      }
    };
    assertCurrent();
    return { sandbox, assertCurrent, signal: revoked.signal, release };
  } catch (error) {
    release();
    throw error;
  }
}
