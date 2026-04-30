import { listAgentIds } from "../agents/agent-scope.js";
import { runBeforeToolCallHook } from "../agents/pi-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../agents/pi-tools.js";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import { applyOwnerOnlyToolPolicy } from "../agents/tool-policy.js";
import { ToolInputError, type AnyAgentTool } from "../agents/tools/common.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { isTestDefaultMemorySlotDisabled } from "../plugins/config-state.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveGatewayScopedTools, type GatewayScopedToolSurface } from "./tool-resolution.js";

const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);

type ToolsInvokeErrorType =
  | "invalid_request"
  | "not_found"
  | "approval_required"
  | "tool_call_blocked"
  | "tool_error";

export type ToolsInvokeBody =
  | {
      ok: true;
      toolName: string;
      output?: unknown;
    }
  | {
      ok: false;
      toolName?: string;
      requiresApproval?: boolean;
      approvalId?: string;
      error: {
        type: ToolsInvokeErrorType;
        message: string;
      };
    };

export type ToolsInvokeCoreResult = {
  status: number;
  body: ToolsInvokeBody;
};

export type InvokeGatewayToolParams = {
  cfg: OpenClawConfig;
  toolName: string;
  args?: unknown;
  action?: string;
  sessionKey?: string;
  agentId?: string;
  confirm?: boolean;
  idempotencyKey?: string;
  senderIsOwner: boolean;
  messageProvider?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  surface?: GatewayScopedToolSurface;
};

function invalidRequest(message: string, toolName?: string): ToolsInvokeCoreResult {
  return {
    status: 400,
    body: {
      ok: false,
      ...(toolName ? { toolName } : {}),
      error: { type: "invalid_request", message },
    },
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
  if (!action) {
    return args;
  }
  if (args.action !== undefined) {
    return args;
  }
  const schemaObj = toolSchema as { properties?: Record<string, unknown> } | null;
  const hasAction = Boolean(
    schemaObj &&
    typeof schemaObj === "object" &&
    schemaObj.properties &&
    "action" in schemaObj.properties,
  );
  if (!hasAction) {
    return args;
  }
  return { ...args, action };
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || String(err);
  }
  if (typeof err === "string") {
    return err;
  }
  return String(err);
}

function resolveToolInputErrorStatus(err: unknown): number | null {
  if (err instanceof ToolInputError) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : 400;
  }
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return null;
  }
  const name = (err as { name?: unknown }).name;
  if (name !== "ToolInputError" && name !== "ToolAuthorizationError") {
    return null;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return status;
  }
  return name === "ToolAuthorizationError" ? 403 : 400;
}

function resolveInvokeScope(params: {
  cfg: OpenClawConfig;
  rawSessionKey?: string;
  rawAgentId?: string;
}): { sessionKey: string; requestedAgentId?: string } | ToolsInvokeCoreResult {
  const requestedAgentId = normalizeOptionalString(params.rawAgentId);
  if (requestedAgentId && !listAgentIds(params.cfg).includes(requestedAgentId)) {
    return invalidRequest(`unknown agent id "${requestedAgentId}"`);
  }

  const rawSessionKey = normalizeOptionalString(params.rawSessionKey);
  const sessionKey =
    rawSessionKey && rawSessionKey !== "main"
      ? rawSessionKey
      : requestedAgentId
        ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: requestedAgentId })
        : resolveMainSessionKey(params.cfg);

  if (requestedAgentId) {
    const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
    if (sessionAgentId !== requestedAgentId) {
      return invalidRequest(
        `agent id "${requestedAgentId}" does not match session agent "${sessionAgentId}"`,
      );
    }
  }

  return { sessionKey, requestedAgentId };
}

function normalizeArgs(argsRaw: unknown): Record<string, unknown> {
  return argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
    ? (argsRaw as Record<string, unknown>)
    : {};
}

function approvalIdFromHookResult(hookResult: { approvalId?: unknown }): string | undefined {
  return normalizeOptionalString(hookResult.approvalId);
}

export async function invokeGatewayTool(
  params: InvokeGatewayToolParams,
): Promise<ToolsInvokeCoreResult> {
  const toolName = normalizeOptionalString(params.toolName) ?? "";
  if (!toolName) {
    return invalidRequest("tools.invoke requires a tool name");
  }

  if (process.env.VITEST && MEMORY_TOOL_NAMES.has(toolName)) {
    const reasons = resolveMemoryToolDisableReasons(params.cfg);
    if (reasons.length > 0) {
      const suffix = reasons.length > 0 ? ` (${reasons.join(", ")})` : "";
      return invalidRequest(
        `memory tools are disabled in tests${suffix}. ` +
          `Enable by setting plugins.slots.memory="${defaultSlotIdForKey("memory")}" (and ensure plugins.enabled is not false).`,
        toolName,
      );
    }
  }

  const scope = resolveInvokeScope({
    cfg: params.cfg,
    rawSessionKey: params.sessionKey,
    rawAgentId: params.agentId,
  });
  if ("status" in scope) {
    return scope;
  }

  const resolveTools = (disablePluginTools: boolean) =>
    resolveGatewayScopedTools({
      cfg: params.cfg,
      sessionKey: scope.sessionKey,
      messageProvider: params.messageProvider,
      accountId: params.accountId,
      agentTo: params.agentTo,
      agentThreadId: params.agentThreadId,
      allowGatewaySubagentBinding: true,
      allowMediaInvokeCommands: true,
      surface: params.surface ?? "http",
      disablePluginTools,
      senderIsOwner: params.senderIsOwner,
    });
  const knownCoreTool = isKnownCoreToolId(toolName);
  let { agentId, tools } = resolveTools(knownCoreTool);
  if (knownCoreTool && !tools.some((candidate) => candidate.name === toolName)) {
    ({ agentId, tools } = resolveTools(false));
  }
  const gatewayFiltered = applyOwnerOnlyToolPolicy(tools, params.senderIsOwner);
  const tool = gatewayFiltered.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return {
      status: 404,
      body: {
        ok: false,
        toolName,
        error: { type: "not_found", message: `Tool not available: ${toolName}` },
      },
    };
  }

  try {
    const gatewayTool: AnyAgentTool = tool;
    const toolCallId = normalizeOptionalString(params.idempotencyKey) ?? `rpc-${Date.now()}`;
    const toolArgs = mergeActionIntoArgsIfSupported({
      toolSchema: gatewayTool.parameters,
      action: normalizeOptionalString(params.action),
      args: normalizeArgs(params.args),
    });
    const hookResult = await runBeforeToolCallHook({
      toolName,
      params: toolArgs,
      toolCallId,
      ctx: {
        agentId,
        sessionKey: scope.sessionKey,
        loopDetection: resolveToolLoopDetectionConfig({ cfg: params.cfg, agentId }),
      },
      approvalMode: params.confirm === true ? "wait" : "request-only",
    });
    if (hookResult.blocked) {
      const approvalId = approvalIdFromHookResult(hookResult);
      if (hookResult.deniedReason === "plugin-approval" && approvalId) {
        return {
          status: 200,
          body: {
            ok: false,
            toolName,
            requiresApproval: true,
            ...(approvalId ? { approvalId } : {}),
            error: { type: "approval_required", message: hookResult.reason },
          },
        };
      }
      return {
        status: 403,
        body: {
          ok: false,
          toolName,
          error: { type: "tool_call_blocked", message: hookResult.reason },
        },
      };
    }
    const output = await gatewayTool.execute(toolCallId, hookResult.params);
    return { status: 200, body: { ok: true, toolName, output } };
  } catch (err) {
    const inputStatus = resolveToolInputErrorStatus(err);
    if (inputStatus !== null) {
      return {
        status: inputStatus,
        body: {
          ok: false,
          toolName,
          error: { type: "tool_error", message: getErrorMessage(err) || "invalid tool arguments" },
        },
      };
    }
    logWarn(`tools-invoke: tool execution failed: ${String(err)}`);
    return {
      status: 500,
      body: {
        ok: false,
        toolName,
        error: { type: "tool_error", message: "tool execution failed" },
      },
    };
  }
}
