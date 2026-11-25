/** Evaluation-scoped bundle MCP tools for headless cron scripts. */
import { TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import {
  wrapToolWithBeforeToolCallHook,
  type HookContext,
} from "../agents/agent-tools.before-tool-call.js";
import type { ResolvedConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../agents/embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";

export type CronScriptMcpTools = {
  /** Settles once the named servers have connected and listed tools, or names each that failed. */
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
  toolsAllow?: string[];
  capabilityProfile: ResolvedConversationCapabilityProfile;
  reservedToolNames: readonly string[];
  hookContext: HookContext;
};

/**
 * Starts the evaluation's own session MCP runtime for the configured servers
 * whose safe name its toolsAllow uses as a prefix (`server__tool` or
 * `server__*`). Wildcards, absent caps, and unprefixed globs start nothing:
 * scripts may poll every 30 seconds, so each server they connect must be an
 * explicit choice. Connection and listing run inside the caller's deadline;
 * `dispose` must run in the caller's `finally`.
 */
export function acquireCronScriptMcpTools(
  params: AcquireCronScriptMcpToolsParams,
): CronScriptMcpTools | undefined {
  const allowed = (params.toolsAllow ?? []).map(normalizeToolPolicyName);
  const explicitToolDenylist = params.capabilityProfile.policy.explicitToolDenylist;
  // Metadata only: no transport starts until acquisition below.
  const { loaded, safeServerNamesByServer } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    toolDenylist: explicitToolDenylist,
    logDiagnostics: false,
  });
  const unnamedServerDenials: string[] = [];
  let namedServerCount = 0;
  for (const serverName of Object.keys(loaded.mcpServers)) {
    const safeName = safeServerNamesByServer.get(serverName) ?? serverName;
    const prefix = `${normalizeToolPolicyName(safeName)}${TOOL_NAME_SEPARATOR}`;
    if (allowed.some((entry) => entry.length > prefix.length && entry.startsWith(prefix))) {
      namedServerCount += 1;
    } else {
      // Whole-namespace denials exclude a server before discovery, keeping safe names stable.
      unnamedServerDenials.push(`${safeName}${TOOL_NAME_SEPARATOR}*`);
    }
  }
  if (namedServerCount === 0) {
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
      toolDenylist: [...explicitToolDenylist, ...unnamedServerDenials],
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
        bundledTools: applyEmbeddedAttemptToolsAllow(candidates, params.toolsAllow, {
          toolMeta: (tool) => getPluginToolMeta(tool),
        }),
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
