import type { SetupFirstAgent } from "../../packages/gateway-protocol/src/schema/setup-inference.js";
import { createAgent } from "../agents/agent-create.js";
import { resolveAgentEntry, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isWorkspaceBootstrapPending } from "../agents/workspace.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { ReadConfigFileSnapshotForWriteResult } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { transformConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { withPluginLifecycleLeaseAsync } from "../plugins/plugin-lifecycle-lease.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { resolveSetupInferenceWorkspace, setupInferenceLog } from "./setup-inference-core.js";

/**
 * Publish the verified model and prospective consent through canonical first-agent creation.
 * Resolves with the published config. Bookkeeping that fails after publication is reported,
 * not thrown, so setup settles from what is on disk and keeps its recovery path.
 */
export async function createSetupFirstAgent(params: {
  config: OpenClawConfig;
  writeSnapshot: ReadConfigFileSnapshotForWriteResult;
  agentId: string;
  beforePersistentApply: () => void;
  prepareConfigCommit: (config: OpenClawConfig) => Promise<void>;
  onCommitted: (config: OpenClawConfig) => void;
}): Promise<OpenClawConfig> {
  let published: OpenClawConfig | undefined;
  let created: Awaited<ReturnType<typeof createAgent>>;
  try {
    created = await withPluginLifecycleLeaseAsync({}, () =>
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
        onCommitted: (result) => {
          published = result.config;
          params.onCommitted(result.config);
        },
      }),
    );
  } catch (error) {
    if (!published) {
      throw error;
    }
    setupInferenceLog.warn(
      `First agent was created, but follow-up bookkeeping failed: ${formatErrorMessage(error)}`,
    );
    return published;
  }
  if (created.status === "error") {
    throw new Error(created.message);
  }
  return created.config;
}

/**
 * Read-only handoff target after verified primary setup. Setup already
 * succeeded, so an unreadable config or workspace omits the target and the
 * client opens its ordinary chat instead of failing the connection.
 */
export async function describeSetupFirstAgent(params: {
  agentId?: string;
}): Promise<SetupFirstAgent | undefined> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return undefined;
    }
    const config = snapshot.config;
    const agentId = tryResolveAmbientOwnerAgentId(config, params.agentId);
    if (!agentId || !resolveAgentEntry(config, agentId)) {
      return undefined;
    }
    return {
      agentId,
      sessionKey: buildAgentMainSessionKey({ agentId, mainKey: config.session?.mainKey }),
      bootstrapPending: await isWorkspaceBootstrapPending(
        resolveAgentWorkspaceDir(config, agentId),
      ),
    };
  } catch (error) {
    setupInferenceLog.warn(
      `First-agent handoff unavailable after setup: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}
