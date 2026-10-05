import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

export const GATEWAY_UPLOADS_DISABLED_CODE = "UPLOADS_DISABLED";
export const GATEWAY_UPLOADS_DISABLED_MESSAGE =
  "File and image uploads are disabled by gateway.uploads.enabled";

/** Client ingress policy, not a restriction on generated media or agent filesystem tools. */
export function areGatewayUploadsEnabled(config: OpenClawConfig | undefined): boolean {
  return config?.gateway?.uploads?.enabled !== false;
}

function disabledUploadError() {
  return errorShape(ErrorCodes.FORBIDDEN, GATEWAY_UPLOADS_DISABLED_MESSAGE, {
    details: { code: GATEWAY_UPLOADS_DISABLED_CODE },
  });
}

/** Pure policy guard suitable for native write admission; it performs no database reads. */
export function assertGatewayUploadsEnabled(config: OpenClawConfig | undefined): void {
  if (!areGatewayUploadsEnabled(config)) {
    throw new SessionMutationAuthorizationChangedError(disabledUploadError());
  }
}

function isNodeUploadRequest(command: string, params: unknown): boolean {
  if (command === "terminal.upload" || command === "browser.proxy.upload.v1") {
    return true;
  }
  return command === "file.write" && isRecord(params) && typeof params.contentBase64 === "string";
}

function hasAttachments(params: Record<string, unknown>): boolean {
  return Array.isArray(params.attachments) && params.attachments.length > 0;
}

function isInlineMedia(value: unknown): boolean {
  return typeof value === "string" && /^data:/i.test(value.trim());
}

function hasInlineMessageMedia(params: Record<string, unknown>): boolean {
  return (
    (typeof params.buffer === "string" && params.buffer.length > 0) ||
    [params.media, params.mediaUrl, params.path, params.filePath].some(isInlineMedia) ||
    (Array.isArray(params.mediaUrls) && params.mediaUrls.some(isInlineMedia))
  );
}

/** Classify bytes accepted from clients, without confusing text edits or downloads with uploads. */
export function isGatewayUploadRequest(method: string, params: unknown): boolean {
  switch (method) {
    case "terminal.upload":
    case "users.setAvatar":
    case "skills.upload.begin":
    case "skills.upload.chunk":
    case "skills.upload.commit":
    case "skills.library.upload":
      return true;
  }
  if (!isRecord(params)) {
    return false;
  }
  switch (method) {
    case "mcp.app.formResource":
      return params.action === "upload";
    case "chat.send":
    case "agent":
    case "sessions.create":
    case "sessions.send":
    case "sessions.steer":
    case "sessions.companion.ask":
      return hasAttachments(params);
    case "node.invoke":
      return (
        typeof params.command === "string" && isNodeUploadRequest(params.command, params.params)
      );
    case "skills.install":
      return params.source === "upload";
    case "skills.library.save":
      return Array.isArray(params.files) && params.files.length > 0;
    case "skills.proposals.create":
    case "skills.proposals.update":
    case "skills.proposals.revise":
      return Array.isArray(params.supportFiles) && params.supportFiles.length > 0;
    case "agents.create":
    case "agents.update":
      return isInlineMedia(params.avatar);
    case "send":
      return hasInlineMessageMedia(params);
    case "message.action":
      return isRecord(params.params) && hasInlineMessageMedia(params.params);
    default:
      return false;
  }
}

type GatewayClientUploadPolicyRequest = {
  method: string;
  requestParams: unknown;
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "getCommittedRuntimeConfig" | "getRuntimeConfig">;
};

/** Trusted in-process media delivery is not client ingress; wire params cannot grant this. */
export function gatewayClientUploadPolicyError(params: GatewayClientUploadPolicyRequest) {
  if (!isGatewayUploadRequest(params.method, params.requestParams)) {
    return null;
  }
  try {
    readOperatorToolGatewayAuthority()?.assertInputCommitAllowed?.();
  } catch (error) {
    if (!(error instanceof SessionMutationAuthorizationChangedError)) {
      throw error;
    }
    return error.error;
  }
  return currentClientUploadPolicyError(params);
}

function currentClientUploadPolicyError(
  params: Pick<GatewayClientUploadPolicyRequest, "client" | "context">,
) {
  if (params.client?.internal?.syntheticClient || params.client?.internal?.agentRuntimeIdentity) {
    return null;
  }
  const config = (params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig)();
  return areGatewayUploadsEnabled(config) ? null : disabledUploadError();
}

/** Carry only client-upload policy into worker commits, never opaque SDK guards that may read SQL. */
export function captureGatewayClientUploadCommitGuard(
  params: Parameters<typeof gatewayClientUploadPolicyError>[0],
): (() => void) | undefined {
  const hasUploads = isGatewayUploadRequest(params.method, params.requestParams);
  const assertInheritedInput = readOperatorToolGatewayAuthority()?.assertInputCommitAllowed;
  if (!hasUploads && !assertInheritedInput) {
    return undefined;
  }
  // Hydration replaces client buffers with stored paths; that cannot erase the original admission.
  return () => {
    assertInheritedInput?.();
    const error = hasUploads ? currentClientUploadPolicyError(params) : null;
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
  };
}
