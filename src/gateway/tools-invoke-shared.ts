// Gateway tool invocation engine.
// Shared implementation behind HTTP and RPC tool invocation adapters.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  buildBundleMcpToolsFromCatalog,
  materializeBundleMcpToolsForRun,
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
} from "../agents/agent-bundle-mcp-tools.js";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../agents/agent-tools.js";
import { getChannelAgentToolMeta } from "../agents/channel-tool-metadata.js";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import {
  AUTOMATIONS_TOOL_NAME,
  isAutomationsToolName,
} from "../agents/tools/automations-tool-name.js";
import { ToolInputError, type AnyAgentTool } from "../agents/tools/common.js";
import {
  normalizeConversationReadInvocationOrigin,
  type ConversationReadInvocationOrigin,
} from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { isTestDefaultMemorySlotDisabled } from "../plugins/config-state.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionStoreEntryProtected,
} from "../sessions/agent-harness-session-key.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { authorizeSessionAgentRun } from "./session-sharing-policy.js";
import {
  authorizeResolvedSessionMutation,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);

/** Protocol input shape accepted by gateway tool invocation surfaces. */
export type ToolsInvokeInput = {
  tool?: unknown;
  name?: unknown;
  action?: unknown;
  args?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
  idempotencyKey?: unknown;
  dryRun?: unknown;
};

type ToolsInvokeErrorType = "invalid_request" | "not_found" | "tool_call_blocked" | "tool_error";

type ToolsInvokeOutcome =
  | {
      ok: true;
      status: 200;
      toolName: string;
      source: "core" | "plugin" | "channel";
      result: unknown;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 500;
      toolName: string;
      error: {
        type: ToolsInvokeErrorType;
        message: string;
        requiresApproval?: boolean;
      };
    };

function resolveSessionTarget(params: { cfg: OpenClawConfig; input: ToolsInvokeInput }) {
  const rawSessionKey = normalizeOptionalString(params.input.sessionKey) ?? "main";
  const resolved = resolveRequestedSessionAgentId(
    params.cfg,
    rawSessionKey,
    normalizeOptionalString(params.input.agentId),
  );
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true as const,
    agentId: resolved.agentId,
    sessionKey: resolveStoredSessionKeyForAgentStore({
      cfg: params.cfg,
      agentId: resolved.agentId,
      sessionKey: rawSessionKey,
    }),
  };
}

function resolveMemoryToolDisableReasons(cfg: OpenClawConfig): string[] {
  if (!process.env.VITEST) {
    return [];
  }
  const reasons: string[] = [];
  const plugins = cfg.plugins;
  const slotRaw = plugins?.slots?.memory;
  const slotDisabled = slotRaw === null || normalizeOptionalLowercaseString(slotRaw) === "none";
  const pluginsDisabled = plugins?.enabled === false;
  const defaultDisabled = isTestDefaultMemorySlotDisabled(cfg);

  if (pluginsDisabled) {
    reasons.push("plugins.enabled=false");
  }
  if (slotDisabled) {
    reasons.push(slotRaw === null ? "plugins.slots.memory=null" : 'plugins.slots.memory="none"');
  }
  if (!pluginsDisabled && !slotDisabled && defaultDisabled) {
    reasons.push("memory plugin disabled by test default");
  }
  return reasons;
}

function mergeActionIntoArgsIfSupported(params: {
  toolSchema: unknown;
  action: string | undefined;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const { toolSchema, action, args } = params;
  if (!action || args.action !== undefined) {
    return args;
  }
  const schemaObj = toolSchema as { properties?: Record<string, unknown> } | null;
  const hasAction = Boolean(
    schemaObj &&
    typeof schemaObj === "object" &&
    schemaObj.properties &&
    "action" in schemaObj.properties,
  );
  return hasAction ? { ...args, action } : args;
}

function resolveToolInputErrorStatus(err: unknown): number | null {
  if (err instanceof ToolInputError) {
    const status = err.status;
    return typeof status === "number" ? status : 400;
  }
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return null;
  }
  const name = err.name;
  if (name !== "ToolInputError" && name !== "ToolAuthorizationError") {
    return null;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return status;
  }
  return name === "ToolAuthorizationError" ? 403 : 400;
}

function resolveToolSource(tool: AnyAgentTool): "core" | "plugin" | "channel" {
  if (getPluginToolMeta(tool)) {
    return "plugin";
  }
  if (getChannelAgentToolMeta(tool)) {
    return "channel";
  }
  return "core";
}

type InvokeGatewayToolParams = {
  cfg: OpenClawConfig;
  input: ToolsInvokeInput;
  messageChannel?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  /** Host-minted authority from the calling connection; never derived from wire params. */
  operatorRoleActor?: NonNullable<GatewayClient["internal"]>["operatorRoleActor"];
  operatorScopes?: readonly string[];
  senderIsOwner?: boolean;
  clientCaps?: string[];
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  toolCallIdPrefix: string;
  approvalMode?: "request" | "report";
  signal?: AbortSignal;
  assertInvocationCurrent?: () => void;
};

async function invokeGatewayToolWithSignal(
  params: InvokeGatewayToolParams & { signal: AbortSignal },
): Promise<ToolsInvokeOutcome> {
  const assertInvocationCurrent = () => {
    params.signal.throwIfAborted();
    params.assertInvocationCurrent?.();
  };
  const conversationReadOrigin = normalizeConversationReadInvocationOrigin(
    params.conversationReadOrigin,
  );
  const requestedToolName = normalizeOptionalString(params.input.name ?? params.input.tool) ?? "";
  // "cron" is a permanently accepted inbound alias for the scheduler tool
  // (owner decision, RFC 0026; same contract as bash -> exec). Canonicalize
  // before core-id checks and exact-name dispatch below.
  const toolName = isAutomationsToolName(requestedToolName)
    ? AUTOMATIONS_TOOL_NAME
    : requestedToolName;
  const failure = (
    status: Extract<ToolsInvokeOutcome, { ok: false }>["status"],
    type: ToolsInvokeErrorType,
    message: string,
    details?: { requiresApproval: boolean },
  ): ToolsInvokeOutcome => ({ ok: false, status, toolName, error: { type, message, ...details } });
  if (!toolName) {
    return failure(400, "invalid_request", "tools.invoke requires name");
  }

  if (process.env.VITEST && MEMORY_TOOL_NAMES.has(toolName)) {
    const reasons = resolveMemoryToolDisableReasons(params.cfg);
    if (reasons.length > 0) {
      const suffix = ` (${reasons.join(", ")})`;
      return failure(
        400,
        "invalid_request",
        `memory tools are disabled in tests${suffix}. ` +
          `Enable by setting plugins.slots.memory="${defaultSlotIdForKey("memory")}" (and ensure plugins.enabled is not false).`,
      );
    }
  }

  const knownCoreTool = isKnownCoreToolId(toolName);
  const gatewayRequestedTools = knownCoreTool ? [] : [toolName];

  const action = normalizeOptionalString(params.input.action);
  const argsRaw = params.input.args;
  const args =
    argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};
  const sessionTarget = resolveSessionTarget({ cfg: params.cfg, input: params.input });
  if (!sessionTarget.ok) {
    return failure(400, "invalid_request", sessionTarget.error.message);
  }
  const { agentId: selectedAgentId, sessionKey } = sessionTarget;
  const authenticatedUserProfile = params.cfg.gateway?.roles
    ? params.authenticatedUserProfile
    : undefined;
  // HTTP and RPC auth boundaries supply authority independently of profile attribution.
  const client = createSyntheticPluginRuntimeClient({
    ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
    operatorRoleActor: params.operatorRoleActor,
    scopes: params.senderIsOwner ? [ADMIN_SCOPE] : [...(params.operatorScopes ?? [])],
  });
  const sessionEntry = loadGatewaySessionEntryReadOnly(sessionKey, {
    agentId: selectedAgentId,
  }).entry;
  const primarySessionAuthorizationError =
    authorizeResolvedSessionMutation({
      cfg: params.cfg,
      client,
      sessionKey,
      agentId: selectedAgentId,
    }) ??
    // Standalone calls cannot create the sandbox provenance a normal session run records.
    (!sessionEntry
      ? authorizeSessionAgentRun({
          cfg: params.cfg,
          client,
          target: { agentId: selectedAgentId, canonicalKey: sessionKey },
        })
      : null);
  if (primarySessionAuthorizationError) {
    return failure(403, "tool_call_blocked", primarySessionAuthorizationError.message);
  }
  if (authenticatedUserProfile && (toolName === "sessions_spawn" || toolName === "sessions_send")) {
    const nestedSessionKey = normalizeOptionalString(args.sessionKey);
    const nestedAgentId = normalizeOptionalString(args.agentId);
    const targetAgent = nestedSessionKey
      ? resolveRequestedSessionAgentId(params.cfg, nestedSessionKey, nestedAgentId)
      : undefined;
    if (targetAgent && !targetAgent.ok) {
      return failure(400, "invalid_request", targetAgent.error.message);
    }
    const targetAgentId = targetAgent?.agentId ?? nestedAgentId ?? selectedAgentId;
    const existingTarget =
      toolName === "sessions_send" && nestedSessionKey
        ? resolveSessionSharingTarget({
            cfg: params.cfg,
            sessionKey: nestedSessionKey,
            agentId: targetAgentId,
          })
        : null;
    const authorizationError =
      (toolName === "sessions_send" && nestedSessionKey
        ? authorizeResolvedSessionMutation({
            cfg: params.cfg,
            client,
            sessionKey: nestedSessionKey,
            agentId: targetAgentId,
          })
        : null) ??
      (!existingTarget
        ? authorizeGatewaySessionCreation({
            cfg: params.cfg,
            client,
            agentId: targetAgentId,
          })
        : null);
    if (authorizationError) {
      return failure(403, "tool_call_blocked", authorizationError.message);
    }
  }
  if (
    isAgentHarnessSessionKey(sessionKey) &&
    (!sessionEntry || isAgentHarnessSessionStoreEntryProtected(sessionKey, sessionEntry))
  ) {
    return failure(400, "invalid_request", AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
  }
  const resolveTools = (disablePluginTools: boolean, additionalTools?: readonly AnyAgentTool[]) =>
    resolveGatewayScopedTools({
      cfg: params.cfg,
      sessionKey,
      sessionId: sessionEntry?.sessionId,
      agentId: selectedAgentId,
      messageProvider: params.messageChannel,
      accountId: params.accountId,
      agentTo: params.agentTo,
      agentThreadId: params.agentThreadId,
      senderIsOwner: params.senderIsOwner,
      clientCaps: params.clientCaps,
      conversationReadOrigin,
      allowGatewaySubagentBinding: true,
      allowMediaInvokeCommands: true,
      surface: "http",
      assertInvocationCurrent,
      disablePluginTools,
      gatewayRequestedTools,
      additionalTools,
    });

  let { agentId, tools, workspaceDir, mcpConfigToolDenylist } = resolveTools(knownCoreTool);
  if (knownCoreTool && !tools.some((candidate) => candidate.name === toolName)) {
    ({ agentId, tools, workspaceDir, mcpConfigToolDenylist } = resolveTools(false));
  }
  const requestedAgentId = normalizeOptionalString(params.input.agentId);
  if (requestedAgentId && agentId && requestedAgentId !== agentId) {
    return failure(
      400,
      "invalid_request",
      `agent id "${requestedAgentId}" does not match session agent "${agentId}"`,
    );
  }
  let tool = tools.find((candidate) => candidate.name === toolName);
  let mcpTools: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  try {
    if (!tool && sessionEntry?.sessionId) {
      // A standalone caller may invoke an already-discovered session tool,
      // but guessing a name must never open a new MCP transport or borrow a
      // requester-scoped credential without an authenticated sender identity.
      const runtime = peekSessionMcpRuntime({ sessionId: sessionEntry.sessionId, sessionKey });
      const catalog = runtime?.peekCatalog();
      if (runtime && catalog) {
        const summary = resolveSessionMcpConfigSummary({
          cfg: params.cfg,
          workspaceDir: runtime.workspaceDir,
          toolOverrides: sessionEntry.toolOverrides,
          toolDenylist: mcpConfigToolDenylist,
        });
        if (runtime.configFingerprint === summary.fingerprint) {
          const reservedToolNames = tools.map((candidate) => candidate.name);
          const candidate = buildBundleMcpToolsFromCatalog({
            catalog,
            reservedToolNames,
          }).find((entry) => entry.name === toolName);
          const mcp = candidate && getPluginToolMeta(candidate)?.mcp;
          const serverName = mcp?.operation === "tool" ? mcp.serverName : undefined;
          if (
            candidate &&
            mcp &&
            serverName &&
            runtime.isRequesterScopedServer?.(serverName) !== true &&
            resolveTools(false, [candidate]).tools.some((entry) => entry.name === toolName)
          ) {
            mcpTools = await materializeBundleMcpToolsForRun({
              runtime,
              agentId,
              reservedToolNames,
            });
            ({ agentId, tools, workspaceDir, mcpConfigToolDenylist } = resolveTools(
              false,
              mcpTools.tools,
            ));
            tool = tools.find((entry) => entry.name === toolName);
            const selectedMcp = tool && getPluginToolMeta(tool)?.mcp;
            if (
              selectedMcp?.operation !== "tool" ||
              selectedMcp.serverName !== mcp.serverName ||
              selectedMcp.toolName !== mcp.toolName
            ) {
              tool = undefined;
            }
          }
        }
      }
    }
    if (!tool) {
      return failure(404, "not_found", `Tool not available: ${toolName}`);
    }
    const idempotencyKey = normalizeOptionalString(params.input.idempotencyKey);
    const toolCallId = idempotencyKey
      ? `${params.toolCallIdPrefix}-${conversationReadOrigin}-${idempotencyKey}`
      : `${params.toolCallIdPrefix}-${conversationReadOrigin}-${Date.now()}`;
    const toolArgs = mergeActionIntoArgsIfSupported({
      toolSchema: tool.parameters,
      action,
      args,
    });
    assertInvocationCurrent();
    const hookResult = await runBeforeToolCallHook({
      toolName,
      params: toolArgs,
      toolCallId,
      ctx: {
        agentId,
        config: params.cfg,
        sessionKey,
        workspaceDir,
        loopDetection: resolveToolLoopDetectionConfig({ cfg: params.cfg, agentId }),
      },
      signal: params.signal,
      approvalMode: params.approvalMode,
    });
    if (hookResult.blocked) {
      return failure(403, "tool_call_blocked", hookResult.reason, {
        requiresApproval: hookResult.deniedReason === "plugin-approval",
      });
    }
    const result = await withOperatorToolGatewayAuthority(
      {
        authenticatedUserProfile,
        operatorRoleActor: params.operatorRoleActor,
        scopes: client.connect.scopes ?? [],
        assertCurrent: assertInvocationCurrent,
      },
      async () => {
        assertInvocationCurrent();
        return await tool.execute?.(toolCallId, hookResult.params, params.signal);
      },
    );
    return {
      ok: true,
      status: 200,
      toolName,
      source: resolveToolSource(tool),
      result,
    };
  } catch (err) {
    const inputStatus = resolveToolInputErrorStatus(err);
    if (inputStatus !== null) {
      return failure(
        inputStatus === 403 ? 403 : 400,
        "tool_error",
        formatErrorMessage(err) || "invalid tool arguments",
      );
    }
    if (!params.signal?.aborted) {
      logWarn(`tools-invoke: tool execution failed: ${String(err)}`);
    }
    return failure(500, "tool_error", "tool execution failed");
  } finally {
    try {
      await mcpTools?.dispose();
    } catch {
      logWarn("tools-invoke: MCP cleanup failed");
    }
  }
}

/** Resolves, authorizes, and invokes one gateway-visible core/plugin/channel tool. */
export async function invokeGatewayTool(
  params: InvokeGatewayToolParams,
): Promise<ToolsInvokeOutcome> {
  const requestAbort = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, requestAbort.signal])
    : requestAbort.signal;
  try {
    return await invokeGatewayToolWithSignal({ ...params, signal });
  } finally {
    requestAbort.abort();
  }
}
