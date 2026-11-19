import { createAgent } from "../agents/agent-create.js";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isWorkspaceBootstrapPending } from "../agents/workspace.js";
import { ensureOnboardingAgent } from "../commands/onboard-agent.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { ReadConfigFileSnapshotForWriteResult } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { transformConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { withPluginLifecycleLeaseAsync } from "../plugins/plugin-lifecycle-lease.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { resolveSetupInferenceWorkspace } from "./setup-inference-core.js";

/** Publish the verified model and prospective consent through canonical first-agent creation. */
export async function createSetupFirstAgent(params: {
  config: OpenClawConfig;
  writeSnapshot: ReadConfigFileSnapshotForWriteResult;
  agentId: string;
  beforePersistentApply: () => void;
  prepareConfigCommit: (config: OpenClawConfig) => Promise<void>;
  onCommitted: (config: OpenClawConfig) => void;
}) {
  const created = await withPluginLifecycleLeaseAsync({}, () =>
    createAgent({
      entry: {
        ...params.config.agents?.entries?.[params.agentId],
        id: params.agentId,
        name: params.agentId,
        workspace: resolveSetupInferenceWorkspace(params.writeSnapshot.snapshot),
      },
      bootstrapFirstAgent: true,
      bootstrapMain: params.agentId === "main",
      stagedConfig: { config: params.config, writeSnapshot: params.writeSnapshot },
      transformConfig: transformConfigWithPendingPluginInstalls,
      deferProactiveJob: true,
      beforePersistentApply: params.beforePersistentApply,
      prepareConfigCommit: params.prepareConfigCommit,
      onCommitted: (result) => params.onCommitted(result.config),
    }),
  );
  if (created.status === "error") {
    throw new Error(created.message);
  }
  return created;
}

/** Completion of verified primary setup, not a replay of Gateway/tool setup defaults. */
export async function completeSetupFirstAgent(params: { agentId?: string; modelRef: string }) {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Cannot finish first-agent setup from an invalid OpenClaw config.");
  }
  let config = snapshot.config;
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    config,
    params.agentId,
    { modelTarget: "primary" },
    snapshot,
  );
  if (!route || route.modelLabel !== params.modelRef) {
    throw new Error(
      "The primary model changed before first-agent setup finished. Verify the selected model again.",
    );
  }
  let agentId = resolveAmbientOwnerAgentId(config, params.agentId);
  let bootstrapPending: boolean;
  if (!hasResolvedRosterBeforeMigrations(snapshot)) {
    if (agentId !== resolveAmbientOwnerAgentId(config)) {
      throw new Error("The requested agent does not exist. Choose the first agent in Model Setup.");
    }
    const created = await ensureOnboardingAgent({
      config: snapshot.sourceConfig,
      workspace: resolveSetupInferenceWorkspace(snapshot),
      expectedConfigHash: snapshot.hash ?? null,
    });
    config = created.config;
    agentId = created.agentId;
    bootstrapPending = created.bootstrapPending;
  } else {
    bootstrapPending = await isWorkspaceBootstrapPending(resolveAgentWorkspaceDir(config, agentId));
  }
  return {
    agentId,
    sessionKey: buildAgentMainSessionKey({ agentId, mainKey: config.session?.mainKey }),
    bootstrapPending,
  };
}
