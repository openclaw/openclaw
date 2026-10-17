import { randomUUID } from "node:crypto";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ApprovalPresentation } from "../../packages/gateway-protocol/src/index.js";
import { sanitizeApprovalScope } from "../infra/approval-scope.js";
import { resolveExecApprovalCommandDisplay } from "../infra/exec-approval-command-display.js";
import {
  exceedsApprovalTextLimit,
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "../infra/exec-approval-text-sanitize.js";
import type { ExecApprovalDecision, ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  truncatePluginApprovalDetail,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../infra/system-agent-approvals.js";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
} from "./exec-approval-manager.types.js";
import type { insertOperatorApproval, OperatorApprovalKind } from "./operator-approval-store.js";

// These opaque ids cross terminal, UI, push, and channel surfaces unchanged.
const EXPLICIT_APPROVAL_ID_INVALID_CHAR_PATTERN = /[^A-Za-z0-9._:-]/;
const PLUGIN_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH = 80;

/** Typed creation failure for an explicit approval id outside the shared safe format. */
export class InvalidApprovalIdError extends Error {
  readonly code = "EXEC_APPROVAL_ID_INVALID";
  readonly reason = "INVALID_APPROVAL_ID";

  constructor() {
    super(
      "approval id must be 1-128 characters using only letters, numbers, '.', '_', ':', or '-', and cannot be '.' or '..'",
    );
    this.name = "InvalidApprovalIdError";
  }
}

export function createExecApprovalRecord<TPayload>(
  request: TPayload,
  timeoutMs: number,
  id?: string | null,
): ExecApprovalRecord<TPayload> {
  const now = Date.now();
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs, { nowMs: now });
  if (expiresAtMs === undefined) {
    throw new Error("approval expiry is unavailable");
  }
  // Empty remains the caller-facing sentinel for manager-generated ids.
  const hasExplicitId = id !== null && id !== undefined && id.length > 0;
  if (
    hasExplicitId &&
    (id.length > 128 ||
      id === "." ||
      id === ".." ||
      EXPLICIT_APPROVAL_ID_INVALID_CHAR_PATTERN.test(id))
  ) {
    throw new InvalidApprovalIdError();
  }
  return {
    id: hasExplicitId ? id : randomUUID(),
    request,
    createdAtMs: now,
    expiresAtMs,
  };
}

function sanitizeOptionalSingleLine(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? sanitizeExecApprovalDisplayText(normalized) : null;
}

function normalizePluginExternalResolution(
  value: PluginApprovalRequestPayload["externalResolution"],
) {
  if (!value) {
    return null;
  }
  const rawLabel = value.label?.trim();
  const label = rawLabel ? sanitizeExecApprovalDisplayText(rawLabel) : "";
  if (!label || exceedsApprovalTextLimit(label, PLUGIN_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH)) {
    throw new Error("invalid external approval label");
  }
  const decisions = value.decisions ?? ["allow-once"];
  if (
    decisions.length < 1 ||
    decisions.length > 2 ||
    decisions.some((decision) => decision !== "allow-once" && decision !== "allow-always") ||
    new Set(decisions).size !== decisions.length
  ) {
    throw new Error("invalid external approval decisions");
  }
  return { label, decisions: [...decisions] };
}

function buildExecApprovalPresentation(
  value: unknown,
  allowedDecisions: ExecApprovalDecision[],
): ApprovalPresentation | null {
  const request = value as ExecApprovalRequestPayload;
  const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(request);
  if (!commandText.trim()) {
    return null;
  }
  const warningText =
    typeof request.warningText === "string" && request.warningText.trim()
      ? sanitizeExecApprovalWarningText(request.warningText)
      : null;
  const scope = request.scope ? sanitizeApprovalScope(request.scope) : null;
  return {
    kind: "exec",
    commandText,
    commandPreview,
    warningText,
    host: sanitizeOptionalSingleLine(request.host),
    nodeId: sanitizeOptionalSingleLine(request.nodeId),
    agentId: sanitizeOptionalSingleLine(request.agentId),
    ...(scope ? { scope } : {}),
    allowedDecisions,
  };
}

function buildPluginApprovalPresentation(
  value: unknown,
  allowedDecisions: ExecApprovalDecision[],
): ApprovalPresentation | null {
  const request = value as PluginApprovalRequestPayload;
  const rawTitle = normalizeOptionalString(request.title);
  const rawDescription = normalizeOptionalString(request.description);
  if (!rawTitle || !rawDescription) {
    return null;
  }
  // Plugin text crosses every reviewer surface. Apply the same redaction and
  // spoof-resistant escaping as exec prompts before enforcing wire-size limits.
  const title = sanitizeExecApprovalDisplayText(rawTitle);
  const description = sanitizeExecApprovalWarningText(rawDescription);
  if (
    exceedsApprovalTextLimit(title, PLUGIN_APPROVAL_TITLE_MAX_LENGTH) ||
    exceedsApprovalTextLimit(description, PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH)
  ) {
    return null;
  }
  const severity =
    request.severity === "info" || request.severity === "warning" || request.severity === "critical"
      ? request.severity
      : "warning";
  const rawDetail = normalizeOptionalString(request.detail);
  const detail = rawDetail
    ? truncatePluginApprovalDetail(sanitizeExecApprovalWarningText(rawDetail))
    : null;
  const scope = request.scope ? sanitizeApprovalScope(request.scope) : null;
  let externalResolution: ReturnType<typeof normalizePluginExternalResolution>;
  try {
    externalResolution = normalizePluginExternalResolution(request.externalResolution);
  } catch {
    return null;
  }
  return {
    kind: "plugin",
    title,
    description,
    ...(detail ? { detail } : {}),
    severity,
    pluginId: sanitizeOptionalSingleLine(request.pluginId),
    toolName: sanitizeOptionalSingleLine(request.toolName),
    agentId: sanitizeOptionalSingleLine(request.agentId),
    ...(scope ? { scope } : {}),
    allowedDecisions,
    ...(externalResolution ? { externalResolution } : {}),
  };
}

function buildSystemAgentApprovalPresentation(value: unknown): ApprovalPresentation | null {
  const request = value as SystemAgentApprovalRequestPayload;
  const title = normalizeOptionalString(request.title);
  const description = normalizeOptionalString(request.description);
  if (!title || !description || !/^[a-f0-9]{64}$/.test(request.proposalHash)) {
    return null;
  }
  return {
    kind: "system-agent",
    title: truncateUtf16Safe(sanitizeExecApprovalDisplayText(title), 80),
    description: truncateUtf16Safe(sanitizeExecApprovalWarningText(description), 512),
    proposalHash: request.proposalHash,
    agentId: sanitizeOptionalSingleLine(request.agentId),
    allowedDecisions: ["allow-once", "deny"],
  };
}

export function prepareExecApprovalPresentation(
  kind: OperatorApprovalKind,
  request: unknown,
  decisions: readonly ExecApprovalDecision[] | undefined,
) {
  const normalized: ExecApprovalDecision[] = [];
  for (const decision of decisions ?? ["allow-once", "allow-always", "deny"]) {
    if (
      (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
      !normalized.includes(decision)
    ) {
      normalized.push(decision);
    }
  }
  // Denial remains valid even when the request supplies malformed allowed decisions.
  if (!normalized.includes("deny")) {
    normalized.push("deny");
  }
  let presentation: ApprovalPresentation | null = null;
  if (isRecord(request)) {
    presentation =
      kind === "exec"
        ? buildExecApprovalPresentation(request, normalized)
        : kind === "plugin"
          ? buildPluginApprovalPresentation(request, normalized)
          : buildSystemAgentApprovalPresentation(request);
  }
  if (!presentation) {
    throw new Error("approval cannot be persisted without a valid reviewer presentation");
  }
  return presentation;
}

function readRequestString(request: unknown, key: string): string | null {
  const value = asOptionalObjectRecord(request)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function prepareExecApprovalRegistration<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  kind: OperatorApprovalKind;
  presentation: ReturnType<typeof prepareExecApprovalPresentation>;
  runtimeEpoch: string;
  resolveAudienceSessionKeys?: ExecApprovalManagerOptions<TPayload>["resolveAudienceSessionKeys"];
}): Promise<Parameters<typeof insertOperatorApproval>[0]["approval"]> {
  const { record } = params;
  const source = {
    agentId: readRequestString(record.request, "agentId"),
    sessionKey: readRequestString(record.request, "sessionKey"),
    sessionId: readRequestString(record.request, "sessionId"),
    runId: readRequestString(record.request, "runId"),
    toolCallId: readRequestString(record.request, "toolCallId"),
    toolName: readRequestString(record.request, "toolName"),
  };
  let audienceSessionKeys: string[] = [];
  if (source.sessionKey) {
    // Gateway owns lineage resolution; without it only the source is included.
    audienceSessionKeys = (await params.resolveAudienceSessionKeys?.(
      source.sessionKey,
      source.agentId,
    )) ?? [source.sessionKey];
  }
  return {
    id: record.id,
    kind: params.kind,
    presentation: params.presentation,
    requester: {
      deviceId: record.requestedByDeviceId,
      clientId: record.requestedByClientId,
      deviceTokenAuth: record.requestedByDeviceTokenAuth === true,
    },
    reviewerDeviceIds: record.approvalReviewerDeviceIds,
    source,
    audienceSessionKeys,
    runtimeEpoch: params.runtimeEpoch,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    ...(record.executionIdentityToken
      ? { executionIdentityToken: record.executionIdentityToken }
      : {}),
  };
}
