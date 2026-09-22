import { randomUUID } from "node:crypto";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { buildApprovalPresentation } from "../infra/approval-presentation.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
} from "./exec-approval-manager.types.js";
import type { insertOperatorApproval, OperatorApprovalKind } from "./operator-approval-store.js";

// These opaque ids cross terminal, UI, push, and channel surfaces unchanged.
const EXPLICIT_APPROVAL_ID_INVALID_CHAR_PATTERN = /[^A-Za-z0-9._:-]/;

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
  const presentation = buildApprovalPresentation({ kind, request, allowedDecisions: normalized });
  if (!presentation) {
    throw new Error("approval cannot be persisted without a valid reviewer presentation");
  }
  return presentation;
}

function readRequestString(request: unknown, key: string): string | null {
  const value = asOptionalObjectRecord(request)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function prepareExecApprovalRegistration<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  kind: OperatorApprovalKind;
  presentation: ReturnType<typeof prepareExecApprovalPresentation>;
  runtimeEpoch: string;
  resolveAudienceSessionKeys?: ExecApprovalManagerOptions<TPayload>["resolveAudienceSessionKeys"];
}): Parameters<typeof insertOperatorApproval>[0]["approval"] {
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
    audienceSessionKeys = params.resolveAudienceSessionKeys?.(
      source.sessionKey,
      source.agentId,
    ) ?? [source.sessionKey];
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
