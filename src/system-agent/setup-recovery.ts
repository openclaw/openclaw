// Machine-local onboarding recovery owns receipt identity and completion validation.
import path from "node:path";
import { listAgentEntries, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveSystemAgentOnboardingTarget } from "../commands/onboard-agent-target.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { readConfigFileSnapshot, withConfigMutationExclusive } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  completeLocalOnboarding,
  readLocalOnboardingStateForConfig,
  type LocalOnboardingState,
} from "../state/local-onboarding-state.js";
import { resolveUserPath } from "../utils.js";

type SetupConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

export type LocalSetupRecovery = {
  workspace: string;
  applyOptions?: {
    resume: true;
    teamCoordinatorId?: string;
    allowWorkspaceChange?: true;
    firstAgent?: { name: string; team: true };
    assertCommitPreconditions: (sourceConfig: OpenClawConfig) => void;
  };
  complete: (
    appliedConfigPath: string,
    authorize: <T>(effect: () => Promise<T> | T) => Promise<T>,
  ) => Promise<SetupConfigSnapshot | undefined>;
};

/** A team receipt owns the complete preset under its root, not just the coordinator. */
export async function matchesLocalSetupWorkspace(
  config: OpenClawConfig,
  workspace: string,
  teamCoordinatorId?: string,
): Promise<boolean> {
  const root = resolveUserPath(workspace);
  if (!teamCoordinatorId) {
    return resolveUserPath(resolveSystemAgentOnboardingTarget(config).workspaceDir) === root;
  }
  const roster = listAgentEntries(config);
  if (roster.length <= 1) {
    return false;
  }
  const target = resolveSystemAgentOnboardingTarget(config);
  if (target.agentId !== teamCoordinatorId) {
    return false;
  }
  const coordinator = roster.find(({ id }) => normalizeAgentId(id) === target.agentId);
  const allowed = coordinator?.subagents?.allowAgents ?? [];
  const { loadAgentTeamPreset } = await import("../agents/agent-roles.js");
  const specialists = (await loadAgentTeamPreset()).specialists.map(({ id }) => id);
  const expectedIds = new Set([target.agentId, ...specialists]);
  return (
    config.agents?.ownership === "explicit" &&
    config.agents.defaults?.systemAgent?.agentId === target.agentId &&
    roster.length === specialists.length + 1 &&
    expectedIds.size === roster.length &&
    coordinator?.subagents?.delegationMode === "prefer" &&
    allowed.length === specialists.length &&
    specialists.every((id) => allowed.includes(id)) &&
    roster.every(({ id, subagents }) => {
      const agentId = normalizeAgentId(id);
      return (
        expectedIds.has(agentId) &&
        resolveAgentWorkspaceDir(config, agentId) === path.join(root, agentId) &&
        (agentId === target.agentId || subagents?.allowAgents?.length === 0)
      );
    })
  );
}

/** Keep canonical config mutations excluded until the SQLite ownership CAS commits. */
export async function completeLocalSetupRecovery(params: {
  owner: LocalOnboardingState;
  appliedConfigPath: string;
  teamCoordinatorId?: string;
}): Promise<SetupConfigSnapshot> {
  return await withConfigMutationExclusive(async (lockedSourceConfig) => {
    const snapshot = await readConfigFileSnapshot();
    const sourceConfig = snapshot.sourceConfig ?? snapshot.config;
    if (
      !snapshot.exists ||
      !snapshot.valid ||
      !snapshot.path ||
      resolveUserPath(snapshot.path) !== params.owner.configPath ||
      (params.appliedConfigPath &&
        resolveUserPath(params.appliedConfigPath) !== params.owner.configPath) ||
      lockedSourceConfig.wizard?.securityAcknowledgedAt !== params.owner.securityAcknowledgedAt ||
      sourceConfig.wizard?.securityAcknowledgedAt !== params.owner.securityAcknowledgedAt ||
      !(await matchesLocalSetupWorkspace(
        snapshot.runtimeConfig ?? snapshot.config,
        params.owner.workspace,
        params.owner.teamCoordinatorId ?? params.teamCoordinatorId,
      ))
    ) {
      throw new Error("The onboarding configuration changed before setup could complete.");
    }
    if (
      readLocalOnboardingStateForConfig(snapshot.path, sourceConfig)?.runId !==
        params.owner.runId ||
      !completeLocalOnboarding({ configPath: snapshot.path, runId: params.owner.runId })
    ) {
      throw new Error("Another onboarding run replaced this setup operation. Retry onboarding.");
    }
    return snapshot;
  });
}

/** Adopt only a valid, local, same-workspace onboarding receipt. */
export async function loadLocalSetupRecovery(
  requestedWorkspace?: string,
): Promise<LocalSetupRecovery> {
  const snapshot = await readConfigFileSnapshot();
  const recorded =
    snapshot.exists &&
    snapshot.valid &&
    (snapshot.sourceConfig ?? snapshot.config)?.gateway?.mode !== "remote"
      ? readLocalOnboardingStateForConfig(snapshot.path, snapshot.sourceConfig ?? snapshot.config)
      : undefined;
  const pending = recorded?.status === "pending" ? recorded : undefined;
  const workspace = resolveUserPath(requestedWorkspace ?? pending?.workspace ?? process.cwd());
  if (pending && workspace !== resolveUserPath(pending.workspace)) {
    throw new Error(
      "Another onboarding run owns a different workspace. Retry onboarding with its approved workspace.",
    );
  }
  let teamCoordinatorId = pending?.teamCoordinatorId;
  if (pending && !teamCoordinatorId) {
    const config = snapshot.runtimeConfig ?? snapshot.config;
    const candidateId = resolveSystemAgentOnboardingTarget(config).agentId;
    if (await matchesLocalSetupWorkspace(config, workspace, candidateId)) {
      teamCoordinatorId = candidateId;
    }
  }
  const assertOwner = (sourceConfig: OpenClawConfig) => {
    if (
      pending &&
      readLocalOnboardingStateForConfig(snapshot.path, sourceConfig)?.runId !== pending.runId
    ) {
      throw new Error("Another onboarding run replaced this setup operation. Retry onboarding.");
    }
  };
  return {
    workspace,
    ...(pending
      ? {
          applyOptions: {
            resume: true as const,
            assertCommitPreconditions: assertOwner,
            ...(teamCoordinatorId
              ? { teamCoordinatorId, allowWorkspaceChange: true as const }
              : {}),
            ...(pending.teamCoordinatorId && !hasResolvedRosterBeforeMigrations(snapshot)
              ? { firstAgent: { name: pending.teamCoordinatorId, team: true as const } }
              : {}),
          },
        }
      : {}),
    async complete(appliedConfigPath, authorize) {
      if (!pending) {
        return undefined;
      }
      return await authorize(() =>
        completeLocalSetupRecovery({ owner: pending, appliedConfigPath, teamCoordinatorId }),
      );
    },
  };
}
