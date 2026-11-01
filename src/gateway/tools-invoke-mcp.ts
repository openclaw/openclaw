/** Invocation-scoped configured MCP tools for standalone gateway tool calls. */
import { randomUUID } from "node:crypto";
import { TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";

/** Materialized tools from one private MCP runtime; the caller must `dispose` it. */
export type InvocationMcpTools = {
  tools: readonly AnyAgentTool[];
  /** Why the owning server listed no tools, when acquisition, connection, or listing failed. */
  unavailable?: string;
  /** Binds MCP App views opened by this call to the caller's final tool surface. */
  restrictAppTools?: (tools: readonly AnyAgentTool[]) => void;
  /** Never rejects; cleanup failures are logged. */
  dispose: () => Promise<void>;
};

type AcquireInvocationMcpToolsParams = {
  toolName: string;
  cfg: OpenClawConfig;
  workspaceDir: string;
  agentId: string;
  agentDir: string;
};

// Returns namespace denials for every configured server except the one owning
// `toolName`, or undefined when no configured server owns it. Reads config only.
function resolveOtherServerDenials(params: AcquireInvocationMcpToolsParams): string[] | undefined {
  const requested = normalizeToolPolicyName(params.toolName);
  const { loaded, safeServerNamesByServer } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: false,
  });
  let owned = false;
  const denials: string[] = [];
  for (const serverName of Object.keys(loaded.mcpServers)) {
    const safeName = safeServerNamesByServer.get(serverName) ?? serverName;
    const prefix = `${normalizeToolPolicyName(safeName)}${TOOL_NAME_SEPARATOR}`;
    if (requested.length > prefix.length && requested.startsWith(prefix)) {
      owned = true;
    } else {
      denials.push(`${safeName}${TOOL_NAME_SEPARATOR}*`);
    }
  }
  return owned ? denials : undefined;
}

/**
 * Connects only the configured MCP server whose safe name prefixes `toolName`
 * and lists its tools on a private runtime. The runtime never takes the
 * session's identity, so agent runs and `tools.effective` keep their own
 * runtime. Standalone calls carry no verified sender, so requester-scoped
 * servers stay fail-closed. Returns undefined when no configured server owns
 * the name. Never rejects: a failed acquisition yields no tools plus an
 * `unavailable` reason. The caller still applies tool policy to the tools.
 */
export async function acquireInvocationMcpTools(
  params: AcquireInvocationMcpToolsParams,
): Promise<InvocationMcpTools | undefined> {
  if (!params.toolName.includes(TOOL_NAME_SEPARATOR)) {
    return undefined;
  }
  const otherServerDenials = resolveOtherServerDenials(params);
  if (!otherServerDenials) {
    return undefined;
  }
  const mcp = await import("../agents/agent-bundle-mcp-tools.js");
  const sessionId = `tools-invoke:${randomUUID()}`;
  const retire = async () => {
    await mcp.retireSessionMcpRuntime({
      sessionId,
      reason: "tools-invoke-complete",
      onError: (error) =>
        logWarn(`tools-invoke: failed to retire MCP runtime ${sessionId}: ${String(error)}`),
    });
  };
  try {
    const lease = await mcp.acquireSessionMcpRuntime({
      sessionId,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      toolDenylist: otherServerDenials,
    });
    const materialized = await mcp.materializeBundleMcpToolsForRun({
      ...lease,
      agentId: params.agentId,
    });
    return {
      tools: materialized.tools,
      unavailable: materialized.diagnostics
        ?.map(({ serverName, message }) => `MCP server "${serverName}" is unavailable: ${message}`)
        .join("; "),
      restrictAppTools: materialized.restrictAppTools,
      // Retirement closes transports first, so an abandoned call cannot outlive its request.
      dispose: async () => {
        await retire();
        await materialized.dispose().catch((error: unknown) => {
          logWarn(`tools-invoke: failed to release MCP tools ${sessionId}: ${String(error)}`);
        });
      },
    };
  } catch (error) {
    logWarn(`tools-invoke: MCP runtime unavailable for ${params.toolName}: ${String(error)}`);
    await retire();
    return { tools: [], unavailable: "MCP server unavailable", dispose: async () => undefined };
  }
}
