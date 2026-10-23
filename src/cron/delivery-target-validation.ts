// Validation helpers for cron delivery targets before jobs enter runtime dispatch.
/** Returns whether a delivery plan names a concrete channel, recipient, thread, or account. */
export function hasExplicitCronDeliveryTarget(plan: {
  target?: "owner";
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
}): boolean {
  return Boolean(
    plan.target ||
    (plan.channel && plan.channel !== "last") ||
    plan.to ||
    plan.threadId != null ||
    plan.accountId,
  );
}

function assertNonBlankStringField(field: string, value: unknown) {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export function assertCronDeliveryInputNonBlankFields(delivery: unknown, fieldPrefix = "delivery") {
  if (!delivery || typeof delivery !== "object") {
    return;
  }
  const deliveryRecord = delivery as {
    channel?: unknown;
    to?: unknown;
    failureDestination?: unknown;
    completionDestination?: unknown;
  };
  assertNonBlankStringField(`${fieldPrefix}.channel`, deliveryRecord.channel);
  assertNonBlankStringField(`${fieldPrefix}.to`, deliveryRecord.to);

  const failureDestination = deliveryRecord.failureDestination;
  if (failureDestination && typeof failureDestination === "object") {
    const failureRecord = failureDestination as { channel?: unknown; to?: unknown };
    assertNonBlankStringField(`${fieldPrefix}.failureDestination.channel`, failureRecord.channel);
    assertNonBlankStringField(`${fieldPrefix}.failureDestination.to`, failureRecord.to);
  }

  const completionDestination = deliveryRecord.completionDestination;
  if (completionDestination && typeof completionDestination === "object") {
    const completionRecord = completionDestination as { to?: unknown };
    assertNonBlankStringField(`${fieldPrefix}.completionDestination.to`, completionRecord.to);
  }
}
