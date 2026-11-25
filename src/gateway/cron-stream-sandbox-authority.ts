import { isDeepStrictEqual } from "node:util";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../agents/conversation-tool-policy-pipeline.js";
import { prepareExecDefaults, resolveExecConfigState } from "../agents/exec-defaults.js";
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
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isSessionMutationActive } from "../sessions/session-controller.lifecycle.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { resolveCronSkillsSnapshot } from "../skills/runtime/cron-snapshot.js";
import type { PreparedUserProfileIdentity } from "../state/user-profiles.types.js";
import { decideOperatorAdmission, prepareOperatorAdmission } from "./operator-admission.js";
import type { RestoredGatewayOperatorAuthority } from "./operator-run-recovery.js";
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

type PreparedSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

class PolicySessionReadRequired extends Error {
  constructor(readonly sessionKey: string) {
    super("Sandbox stream policy requires current related session facts.");
  }
}

/** Admit current requester policy once; retain the sandbox and session data owners. */
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
  let config = params.getRuntimeConfig();
  const { operator, ...sandboxTarget } = target;
  const principal = operator?.openclawIdPrincipal;
  params.assertCurrent();
  params.signal?.throwIfAborted();
  let requester: Pick<RestoredGatewayOperatorAuthority, "authority" | "release"> | undefined;
  const client = operator
    ? createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "operator", profileId: operator.profileId },
        // The host-recorded requester is admitted below; scopes remain a ceiling.
        openclawIdPrincipal: principal,
        scopes: [...operator.scopes],
      })
    : undefined;
  const revoked = new AbortController();
  const subscriptions: Array<() => void> = [];
  let profile: PreparedUserProfileIdentity | undefined;
  let session: PreparedSession | undefined;
  const policySessions = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
  let policyPrepared = false;
  let admitted = false;
  let runtime: ReturnType<typeof resolveSandboxRuntimeStatus> | undefined;
  let references = 1;
  let released = false;
  let disposeSandbox: (() => void) | undefined;
  const unavailable = () =>
    new Error(
      "Sandbox stream session or resource changed; recreate this automation from the current session.",
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
      requester?.release();
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
      modelProvider: model?.provider,
      modelId: model?.model,
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
    const currentConfig = config;
    const facts = session?.readCurrent(currentConfig);
    const entry = facts?.target.entry;
    if (
      session &&
      isSessionMutationActive(
        session.storageTarget.storePath,
        [target.sessionKey, target.sessionId],
        ["reset", "delete"],
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
    if (entry && !admitted) {
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
    return { currentConfig, entry, facts };
  };
  const assertAuthorityCurrent = () => {
    try {
      assertPreparedCurrent();
    } catch (error) {
      revoke(error);
      throw error;
    }
  };
  const recheck = () => {
    try {
      assertPreparedCurrent();
    } catch (error) {
      revoke(error);
    }
  };
  const sourceAborted = () => revoke(params.signal?.reason ?? unavailable());
  subscriptions.push(
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
      const source = { kind: "recorded", snapshot: operator, agentId: target.agentId } as const;
      const preparation = await prepareOperatorAdmission(source, {
        getRuntimeConfig: params.getRuntimeConfig,
      });
      requester = decideOperatorAdmission(source, preparation);
      profile = preparation.identity;
      config = preparation.config;
      if (!operatorScopeSatisfied("operator.write", requester.authority.scopes)) {
        throw unavailable();
      }
      if (client) {
        client.connect.scopes = [...requester.authority.scopes];
      }
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
    if (client && profile && prepared.facts) {
      const identity = profile.readCurrentFacts();
      if (
        authorizePreparedSessionMutation(
          { cfg: config, client, agentId: target.agentId, sessionKey: target.sessionKey },
          prepared.facts,
          {
            policy: requester?.authority.readCurrentRoleFacts?.().policy,
            aliases: identity.aliases,
          },
        )
      ) {
        throw unavailable();
      }
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
    // Policy changes affect the next process start, not this admitted process.
    admitted = true;
    const authority = requester
      ? createAdmittedRunOperatorAuthority({
          ...requester.authority,
          signal: revoked.signal,
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
        if (!current.entry) {
          throw unavailable();
        }
        const captured = captureCronStreamSandboxTarget({
          sandbox,
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          entry: current.entry,
        });
        delete captured.operator;
        if (!isDeepStrictEqual(captured, sandboxTarget)) {
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
