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

/**
 * Resolver attribution the Gateway approval ledger recorded for this request.
 * Descriptive only: it names the resolving device, channel reviewer, runtime
 * client, or system outcome, and never proves a distinct person approved.
 */
export type PluginApprovalResolutionDetails = {
  resolvedAtMs: number;
  resolver?: {
    kind: "device" | "channel" | "runtime" | "system";
    id?: string;
  };
};

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
    /**
     * Informational: not awaited and cannot change the outcome. `details` is
     * present only when the Gateway recorded the resolution.
     */
    onResolution?: (
      decision: PluginApprovalResolution,
      details?: PluginApprovalResolutionDetails,
    ) => Promise<void> | void;
  };
};
