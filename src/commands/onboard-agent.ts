// First-run main-agent creation through the canonical agent service.
import { createAgent } from "../agents/agent-create.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { createMergePatch } from "../config/merge-patch.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliAgentId, type CliAgentSelectionDeps } from "./agent-selection.js";

function isInjectedMainRoster(config: OpenClawConfig): boolean {
  const roster = listAgentEntries(config);
  const entry = roster[0];
  return (
    roster.length === 1 && entry?.id === "main" && Object.keys(entry).every((key) => key === "id")
  );
}

function mergeOnboardingCandidate(params: {
  base: OpenClawConfig;
  candidate: OpenClawConfig;
  currentRuntime: OpenClawConfig;
}): OpenClawConfig {
  const proposalPatch = createMergePatch(params.base, params.candidate);
  // Keep this runtime-shaped. The canonical config writer projects only this
  // patch onto snapshot.parsed, preserving include ownership and env refs.
  const merged = applyMergePatch(params.currentRuntime, proposalPatch) as OpenClawConfig;
  const { list: _legacyList, ...agents } = merged.agents ?? {};
  const entries = toAgentEntriesRecord(listAgentEntries(params.currentRuntime));
  return {
    ...merged,
    agents: {
      ...agents,
      ...(Object.keys(entries).length > 1 ? { ownership: "explicit" as const } : {}),
      entries,
    },
  };
}

export type EnsureOnboardingAgentParams = {
  config: OpenClawConfig;
  workspace: string;
  preserveCandidateRoster?: boolean;
  candidateRosterIsStagedFirstAgent?: boolean;
  baseConfig?: OpenClawConfig;
  agentId?: string;
  runtime?: RuntimeEnv;
  selectionDeps?: CliAgentSelectionDeps;
};

export async function ensureOnboardingAgent(params: EnsureOnboardingAgentParams): Promise<{
  config: OpenClawConfig;
  agentId: string;
  bootstrapPending: boolean;
  /**
   * Config hash observed after this helper created the first roster agent.
   * Callers that captured a hash before calling must adopt it for their own
   * commit: the create wrote the file, so their baseline is stale but not
   * foreign, and the optimistic guard would otherwise reject their write.
   */
  configHash?: string;
}> {
  const candidateRoster = listAgentEntries(params.config);
  if (
    candidateRoster.length > 0 &&
    !params.candidateRosterIsStagedFirstAgent &&
    (params.preserveCandidateRoster || !isInjectedMainRoster(params.config))
  ) {
    const migratedConfig = migratePersistedImplicitMainRoster(params.config)
      .config as OpenClawConfig;
    const config = inheritLegacyDefaultAgentId(
      migratedConfig,
      candidateRoster.length > 1
        ? {
            ...migratedConfig,
            agents: { ...migratedConfig.agents, ownership: "explicit" as const },
          }
        : migratedConfig,
    );
    return {
      config,
      agentId: await resolveCliAgentId({
        cfg: config,
        runtime: params.runtime ?? defaultRuntime,
        agentInput: params.agentId,
        surface: "onboarding",
        deps: params.selectionDeps,
      }),
      bootstrapPending: false,
    };
  }
  const before = await readConfigFileSnapshot();
  if (before.exists && !before.valid) {
    throw new Error("Cannot create the first agent from an invalid OpenClaw config.");
  }
  const effective = before.config;
  const candidateBase = params.baseConfig ?? effective;
  if (before.exists && listAgentEntries(effective).length > 0) {
    const config = mergeOnboardingCandidate({
      base: candidateBase,
      candidate: params.config,
      currentRuntime: effective,
    });
    return {
      config,
      agentId: await resolveCliAgentId({
        cfg: config,
        runtime: params.runtime ?? defaultRuntime,
        agentInput: params.agentId,
        surface: "onboarding",
        deps: params.selectionDeps,
      }),
      bootstrapPending: false,
    };
  }
  const initialAgentId = normalizeAgentId(params.agentId?.trim() || "main");
  const created = await createAgent({
    entry: {
      id: initialAgentId,
      name: initialAgentId,
      workspace: params.workspace,
    },
    ...(initialAgentId === "main" ? { bootstrapMain: true } : {}),
    skipBootstrap: params.config.agents?.defaults?.skipBootstrap,
    skipOptionalBootstrapFiles: params.config.agents?.defaults?.skipOptionalBootstrapFiles,
  });
  if (created.status === "error") {
    throw new Error(created.message);
  }
  const after = await readConfigFileSnapshot();
  if (!after.valid) {
    throw new Error("Agent creation wrote an invalid OpenClaw config.");
  }
  return {
    config: mergeOnboardingCandidate({
      base: candidateBase,
      candidate: params.config,
      currentRuntime: after.config,
    }),
    agentId: created.agentId,
    bootstrapPending: created.bootstrapPending,
    ...(after.hash !== undefined ? { configHash: after.hash } : {}),
  };
}

export function ensureOnboardingConfig(
  config: OpenClawConfig,
  workspace: string,
  preserveCandidateRoster = false,
  baseConfig?: OpenClawConfig,
) {
  return ensureOnboardingAgent({ config, workspace, preserveCandidateRoster, baseConfig });
}
