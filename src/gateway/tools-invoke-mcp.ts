/** Invocation-scoped configured MCP tools for standalone gateway tool calls. */
import { randomUUID } from "node:crypto";
import { TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
import { runWithSessionMcpRequestSignal } from "../agents/agent-bundle-mcp-request-context.js";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { sessionMutationForbiddenError } from "./session-mutation-authorization-error.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

type SessionMcpOverrides = Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;

const fingerprintMcpOverrides = (overrides: SessionMcpOverrides | undefined) =>
  JSON.stringify([overrides?.mcpServers ?? null, overrides?.mcpToolsDeny ?? null]);

// Retains a live read of the selected session and returns a check that rejects
// once its MCP overrides differ from those the tools were materialized with, so
// a server disabled or a tool denied during an awaited hook or catalog wait
// cannot still reach server I/O.
async function prepareSessionMcpOverridesCheck(params: AcquireInvocationMcpToolsParams) {
  const facts = await prepareSessionMutationFacts({
    cfg: params.cfg,
    sessionKey: params.session.key,
    agentId: params.agentId,
    allowMissing: true,
  });
  const expected = fingerprintMcpOverrides(params.session.entry?.toolOverrides);
  const assertCurrent = () => {
    const current = facts.readCurrent(getRuntimeConfig()).target?.entry?.toolOverrides;
    if (fingerprintMcpOverrides(current) !== expected) {
      throw sessionMutationForbiddenError("Session MCP policy changed; retry the request");
    }
  };
  return { assertCurrent, release: facts.release };
}

/** Materialized tools from one private MCP runtime, whose disposal and policy check the owner holds. */
export type InvocationMcpTools = {
  tools: readonly AnyAgentTool[];
  /** Why the owning server listed no tools, when acquisition, connection, or listing failed. */
  unavailable?: string;
  /** Binds MCP App views opened by this call to the caller's final tool surface. */
  restrictAppTools?: (tools: readonly AnyAgentTool[]) => void;
};

type AcquireInvocationMcpToolsParams = {
  toolName: string;
  /**
   * Gateway tool names already resolved for this caller. A requested name among them never
   * connects MCP; MCP names colliding with them get the suffixes tools.effective advertises.
   */
  reservedToolNames: readonly string[];
  cfg: OpenClawConfig;
  workspaceDir: string;
  agentId: string;
  /** The selected session, whose MCP overrides disable servers and deny tools. */
  session: { key: string; entry: { toolOverrides?: SessionMcpOverrides } | undefined };
  /** Invocation-owned lists that receive this runtime's disposal and its session-policy check. */
  owner: { disposals: Array<() => Promise<void>>; sessionChecks: Array<() => void> };
  /** Request cancellation; aborts pending discovery and retires the runtime. */
  signal: AbortSignal;
};

// Returns namespace denials for every configured server except the one owning
// `toolName`, or undefined when no enabled server owns it. Reads config only.
function resolveOtherServerDenials(params: AcquireInvocationMcpToolsParams): string[] | undefined {
  const requested = normalizeToolPolicyName(params.toolName);
  const { loaded, safeServerNamesByServer } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    toolOverrides: params.session.entry?.toolOverrides,
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
 * Connects only the enabled MCP server whose safe name prefixes `toolName` and
 * lists its tools on a private runtime, applying the session's MCP overrides.
 * The runtime never takes the session's identity, so agent runs and
 * `tools.effective` keep their own runtime. Standalone calls carry no verified
 * sender, so requester-scoped servers stay fail-closed. Returns undefined when
 * no enabled server owns the name. A failed acquisition yields no tools plus an
 * `unavailable` reason; only cancellation rejects, after the runtime retires.
 * The caller still applies tool policy to the returned tools.
 */
export async function acquireInvocationMcpTools(
  params: AcquireInvocationMcpToolsParams,
): Promise<InvocationMcpTools | undefined> {
  if (
    params.reservedToolNames.includes(params.toolName) ||
    !params.toolName.includes(TOOL_NAME_SEPARATOR)
  ) {
    return undefined;
  }
  const otherServerDenials = resolveOtherServerDenials(params);
  if (!otherServerDenials) {
    return undefined;
  }
  const { signal } = params;
  signal.throwIfAborted();
  const sessionPolicy = await prepareSessionMcpOverridesCheck(params);
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
  // Acquisition owns cancellation until the caller receives its disposal handle:
  // an abort closes the pending connection instead of waiting for discovery to settle.
  let abortRetirement: Promise<void> | undefined;
  const onAbort = () => {
    abortRetirement ??= retire();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const materialized = await runWithSessionMcpRequestSignal(signal, async () => {
      const lease = await mcp.acquireSessionMcpRuntime({
        sessionId,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        agentDir: resolveAgentDir(params.cfg, params.agentId),
        cfg: params.cfg,
        toolOverrides: params.session.entry?.toolOverrides,
        toolDenylist: otherServerDenials,
      });
      return await mcp.materializeBundleMcpToolsForRun({
        ...lease,
        agentId: params.agentId,
        reservedToolNames: params.reservedToolNames,
      });
    });
    // Retirement closes transports first, so an abandoned call cannot outlive its request.
    const dispose = async () => {
      sessionPolicy.release();
      await retire();
      await materialized.dispose().catch((error: unknown) => {
        logWarn(`tools-invoke: failed to release MCP tools ${sessionId}: ${String(error)}`);
      });
    };
    if (signal.aborted) {
      await dispose();
      signal.throwIfAborted();
    }
    // The owner retires the runtime (never rejecting; cleanup failures are logged) and rejects
    // effects once the session's MCP overrides change.
    params.owner.disposals.push(dispose);
    params.owner.sessionChecks.push(sessionPolicy.assertCurrent);
    return {
      tools: materialized.tools,
      unavailable: materialized.diagnostics
        ?.map(({ serverName, message }) => `MCP server "${serverName}" is unavailable: ${message}`)
        .join("; "),
      restrictAppTools: materialized.restrictAppTools,
    };
  } catch (error) {
    sessionPolicy.release();
    await (abortRetirement ?? retire());
    signal.throwIfAborted();
    logWarn(`tools-invoke: MCP runtime unavailable for ${params.toolName}: ${String(error)}`);
    return { tools: [], unavailable: "MCP server unavailable" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    await abortRetirement;
  }
}
