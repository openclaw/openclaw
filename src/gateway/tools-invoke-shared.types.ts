import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

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

export type ToolsInvokeErrorType =
  | "invalid_request"
  | "not_found"
  | "tool_call_blocked"
  | "tool_error";

export type ToolsInvokeOutcome =
  | {
      ok: true;
      status: 200;
      toolName: string;
      source: "core" | "plugin" | "mcp" | "channel";
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

export type InvokeGatewayToolParams = {
  cfg: OpenClawConfig;
  input: ToolsInvokeInput;
  messageChannel?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  /** Host-minted authority from the calling connection; never derived from wire params. */
  operatorRoleActor?: NonNullable<GatewayClient["internal"]>["operatorRoleActor"];
  /** Original authenticated HTTP principal or the enclosing RPC scope's principal. */
  openclawIdPrincipal?: NonNullable<GatewayClient["internal"]>["openclawIdPrincipal"];
  operatorProfileEnrollment?: NonNullable<GatewayClient["internal"]>["operatorProfileEnrollment"];
  operatorScopes?: readonly string[];
  approvalReviewerDeviceId?: string;
  senderIsOwner?: boolean;
  clientCaps?: string[];
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  toolCallIdPrefix: string;
  approvalMode?: "request" | "report";
  signal?: AbortSignal;
  assertInvocationCurrent?: () => void;
};
