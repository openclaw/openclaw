import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./hook-types.js";

export type PluginJsonPrimitive = string | number | boolean | null;
export type PluginJsonValue =
  | PluginJsonPrimitive
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export type PluginHostCleanupReason = "disable" | "reset" | "delete" | "restart";

export type PluginSessionExtensionProjectionContext = {
  sessionKey: string;
  sessionId?: string;
  state: PluginJsonValue | undefined;
};

export type PluginSessionExtensionRegistration = {
  namespace: string;
  description: string;
  project?: (
    ctx: PluginSessionExtensionProjectionContext,
  ) => PluginJsonValue | undefined | Promise<PluginJsonValue | undefined>;
  cleanup?: (ctx: { reason: PluginHostCleanupReason; sessionKey?: string }) => void | Promise<void>;
};

export type PluginSessionExtensionProjection = {
  pluginId: string;
  namespace: string;
  value: PluginJsonValue;
};

export type PluginSessionExtensionPatchParams = {
  key: string;
  pluginId: string;
  namespace: string;
  value?: PluginJsonValue;
  unset?: boolean;
};

export type PluginNextTurnInjectionPlacement = "prepend_context" | "append_context";

export type PluginNextTurnInjection = {
  sessionKey: string;
  text: string;
  idempotencyKey?: string;
  placement?: PluginNextTurnInjectionPlacement;
  ttlMs?: number;
  metadata?: PluginJsonValue;
};

export type PluginNextTurnInjectionRecord = Omit<PluginNextTurnInjection, "sessionKey"> & {
  id: string;
  pluginId: string;
  pluginName?: string;
  createdAt: number;
  placement: PluginNextTurnInjectionPlacement;
};

export type PluginNextTurnInjectionEnqueueResult = {
  enqueued: boolean;
  id: string;
  sessionKey: string;
};

export type PluginToolPolicyDecision =
  | PluginHookBeforeToolCallResult
  | {
      allow?: boolean;
      reason?: string;
    };

export type PluginTrustedToolPolicyRegistration = {
  id: string;
  description: string;
  evaluate: (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => PluginToolPolicyDecision | void | Promise<PluginToolPolicyDecision | void>;
};

export type PluginToolMetadataRegistration = {
  toolName: string;
  displayName?: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  tags?: string[];
};

export type PluginCommandContinuation = {
  continueAgent?: boolean;
};

export type PluginControlUiDescriptor = {
  id: string;
  surface: "session" | "tool" | "run" | "settings";
  label: string;
  description?: string;
  placement?: string;
  schema?: PluginJsonValue;
  requiredScopes?: OperatorScope[];
};

export type PluginRuntimeLifecycleRegistration = {
  id: string;
  description?: string;
  cleanup?: (ctx: {
    reason: PluginHostCleanupReason;
    sessionKey?: string;
    runId?: string;
  }) => void | Promise<void>;
};

export type PluginAgentTurnPrepareEvent = {
  prompt: string;
  messages: AgentMessage[] | unknown[];
  queuedInjections: PluginNextTurnInjectionRecord[];
};

export type PluginAgentTurnPrepareResult = {
  prependContext?: string;
  appendContext?: string;
};

export type PluginHeartbeatPromptContributionEvent = {
  sessionKey?: string;
  agentId?: string;
  heartbeatName?: string;
};

export type PluginHeartbeatPromptContributionResult = {
  prependContext?: string;
  appendContext?: string;
};

export function normalizePluginHostHookId(value: string | undefined): string {
  return (value ?? "").trim();
}

export function isPluginJsonValue(value: unknown): value is PluginJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isPluginJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isPluginJsonValue);
}

export function buildPluginAgentTurnPrepareContext(params: {
  queuedInjections: PluginNextTurnInjectionRecord[];
}): PluginAgentTurnPrepareResult {
  const prepend = params.queuedInjections
    .filter((entry) => entry.placement === "prepend_context")
    .map((entry) => entry.text.trim())
    .filter(Boolean);
  const append = params.queuedInjections
    .filter((entry) => entry.placement === "append_context")
    .map((entry) => entry.text.trim())
    .filter(Boolean);
  return {
    ...(prepend.length > 0 ? { prependContext: prepend.join("\n\n") } : {}),
    ...(append.length > 0 ? { appendContext: append.join("\n\n") } : {}),
  };
}

export type PluginHostHookRunContext = PluginHookAgentContext;
