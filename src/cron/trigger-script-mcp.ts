/** Evaluation-scoped bundle MCP tools for headless cron scripts. */
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import {
  wrapToolWithBeforeToolCallHook,
  type HookContext,
} from "../agents/agent-tools.before-tool-call.js";
import type { ResolvedConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../agents/embedded-agent-runner/effective-tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";

export type CronScriptMcpTools = {
  /** Settles once the configured servers have connected and listed tools, or names each that failed. */
  surface: Promise<{ tools: AnyAgentTool[]; unavailable?: string }>;
  /** Retires the evaluation's MCP runtime, including servers still connecting. */
  dispose: () => Promise<void>;
};

type AcquireCronScriptMcpToolsParams = {
  /** Unique per evaluation: the runtime is never shared with another run. */
  sessionId: string;
  sessionKey: string;
  agentId: string;
  config: OpenClawConfig;
  workspaceDir: string;
  agentDir: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  reservedToolNames: readonly string[];
  hookContext: HookContext;
};

/**
 * Starts the evaluation's own MCP runtime using the current agent configuration
 * and tool policy. Connection and listing run inside the caller's deadline;
 * `dispose` must run in the caller's `finally`.
 */
export function acquireCronScriptMcpTools(
  params: AcquireCronScriptMcpToolsParams,
): CronScriptMcpTools | undefined {
  const explicitToolDenylist = params.capabilityProfile.policy.explicitToolDenylist;
  // Metadata only: no transport starts until acquisition below.
  const { loaded } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    toolDenylist: explicitToolDenylist,
    logDiagnostics: false,
  });
  if (Object.keys(loaded.mcpServers).length === 0) {
    return undefined;
  }
  const mcpModule = import("../agents/agent-bundle-mcp-tools.js");
  // Cron runs carry no verified sender, so requester-scoped servers stay fail-closed.
  const acquisition = mcpModule.then(async (mcp) => ({
    mcp,
    lease: await mcp.acquireSessionMcpRuntime({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.config,
      toolDenylist: explicitToolDenylist,
    }),
  }));
  const materialization = acquisition.then(({ mcp, lease }) =>
    mcp.materializeBundleMcpToolsForRun({
      ...lease,
      agentId: params.agentId,
      reservedToolNames: params.reservedToolNames,
    }),
  );
  const surface = materialization.then((materialized) => {
    const applyPolicy = (candidates: AnyAgentTool[]) =>
      applyFinalEffectiveToolPolicy({
        bundledTools: candidates,
        config: params.config,
        workspaceDir: params.workspaceDir,
        conversationCapabilityProfile: params.capabilityProfile,
        warn: (message) => logWarn(message),
      });
    // App views outlive this evaluation; bind them to the same final policy.
    materialized.restrictAppTools?.(applyPolicy(materialized.appTools ?? materialized.tools));
    return {
      tools: applyPolicy(materialized.tools).map((tool) =>
        wrapToolWithBeforeToolCallHook(tool, params.hookContext),
      ),
      unavailable: materialized.diagnostics
        ?.map(({ serverName, message }) => `MCP server "${serverName}" is unavailable: ${message}`)
        .join("; "),
    };
  });
  void surface.catch(() => undefined);
  return {
    surface,
    dispose: async () => {
      const acquired = await acquisition.catch(() => undefined);
      if (!acquired) {
        return;
      }
      // Retirement closes transports first, so a deadline-abandoned connect cannot outlive the run.
      await acquired.mcp.retireSessionMcpRuntime({
        sessionId: params.sessionId,
        reason: "cron-script-complete",
        onError: (error, sessionId) =>
          logWarn(`cron: failed to retire script MCP runtime ${sessionId}: ${String(error)}`),
      });
      const materialized = await materialization.catch(() => undefined);
      await materialized?.dispose();
    },
  };
}
