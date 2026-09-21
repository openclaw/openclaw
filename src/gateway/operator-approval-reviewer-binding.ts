import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

function normalizeIdentity(value: string | null | undefined): string | null {
  return normalizeOptionalString(value) ?? null;
}

function normalizeIdentities(values: readonly string[] | null | undefined): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const identity = normalizeIdentity(value);
    if (identity) {
      normalized.add(identity);
    }
  }
  return [...normalized];
}

/** Match a durable binding after the caller's broad authority has been established. */
export function matchesOperatorApprovalReviewerBinding(
  binding: { reviewerDeviceIds?: readonly string[] | null },
  deviceId: string | null | undefined,
): boolean {
  const clientDeviceId = normalizeIdentity(deviceId);
  const reviewerDeviceIds = normalizeIdentities(binding.reviewerDeviceIds);
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
