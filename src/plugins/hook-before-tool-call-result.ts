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
  /**
   * Hook-authored request metadata merged into the call's `_meta` lane by the
   * invocation owner. Only this explicit signal is trusted: params `_meta`
   * content is caller/model-controlled and never establishes authorship.
   * Shallow-merged per key across hooks in registration order (later hooks win
   * per key). Not subject to the approval params lock: the operator reviews
   * params and approval text, and hooks are already privileged code — locking
   * this lane would silently drop a stamping hook registered after an approval
   * hook.
   */
  requestMeta?: Record<string, unknown>;
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
