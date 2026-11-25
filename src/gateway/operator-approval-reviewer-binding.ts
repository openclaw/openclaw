import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

/** Match a durable binding after the caller's broad authority has been established. */
export function matchesOperatorApprovalReviewerBinding(
  binding: { reviewerDeviceIds?: readonly string[] | null },
  deviceId: string | null | undefined,
): boolean {
  const clientDeviceId = normalizeOptionalString(deviceId);
  const reviewerDeviceIds = normalizeUniqueTrimmedStringList([
    ...(binding.reviewerDeviceIds ?? []),
  ]);
  if (reviewerDeviceIds.length > 0) {
    return Boolean(clientDeviceId && reviewerDeviceIds.includes(clientDeviceId));
  }

  // No explicit reviewer binding: the operator.approvals scope tier is the
  // access authority, matching the shipped contract where any authorized
  // approval surface (Telegram buttons, macOS app, control UI) may resolve
  // any pending approval. Cross-surface first-answer-wins depends on this;
  // reviewerDeviceIds is the opt-in restriction, and requester identity gates
  // only the legacy adapters in approval-shared.
  return true;
}

/** One session's live participation approvals, resolved for one client before a bounded read. */
export type OperatorApprovalExecSelection = Readonly<{
  include: readonly string[];
  exclude: readonly string[];
  /** False when the client may see only the included approvals. */
  ordinary: boolean;
}>;

/** Selection overrides reviewer bindings only for exec approvals it names. */
export function matchesOperatorApprovalSelection(
  record: { id: string; kind: string; reviewerDeviceIds?: readonly string[] | null },
  reviewerDeviceId: string | undefined,
  selection: OperatorApprovalExecSelection | undefined,
): boolean {
  if (record.kind === "exec" && selection) {
    if (selection.exclude.includes(record.id)) {
      return false;
    }
    if (selection.include.includes(record.id)) {
      return true;
    }
    if (!selection.ordinary) {
      return false;
    }
  }
  return (
    reviewerDeviceId === undefined ||
    matchesOperatorApprovalReviewerBinding(record, reviewerDeviceId)
  );
}
