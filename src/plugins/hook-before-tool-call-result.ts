import type { ApprovalScope } from "../infra/approval-scope.js";

export const PluginApprovalResolutions = {
  ALLOW_ONCE: "allow-once",
  ALLOW_ALWAYS: "allow-always",
  DENY: "deny",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
} as const;

export type PluginApprovalResolution =
  (typeof PluginApprovalResolutions)[keyof typeof PluginApprovalResolutions];

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    scope?: ApprovalScope;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    /** Override timeout text and return the timeout as a blocked tool result. */
    timeoutReason?: string;
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
    onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
  };
};
