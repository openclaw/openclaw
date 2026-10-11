const SCHEDULED_RUN_PREFIX = "cron-slot-v1.";

export function createCronScheduledRunId(
  storeKey: string,
  jobId: string,
  scheduledSlotMs: number,
  attemptId?: string,
): string {
  return (
    SCHEDULED_RUN_PREFIX +
    Buffer.from(
      JSON.stringify([storeKey, jobId, scheduledSlotMs, ...(attemptId ? [attemptId] : [])]),
    ).toString("base64url")
  );
}

export function parseCronScheduledRunId(
  receiptId: string,
): { storeKey: string; jobId: string; scheduledSlotMs: number } | undefined {
  if (!receiptId.startsWith(SCHEDULED_RUN_PREFIX)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      Buffer.from(receiptId.slice(SCHEDULED_RUN_PREFIX.length), "base64url").toString("utf8"),
    );
    if (
      Array.isArray(value) &&
      (value.length === 3 || (value.length === 4 && typeof value[3] === "string")) &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      typeof value[2] === "number" &&
      Number.isSafeInteger(value[2])
    ) {
      return { storeKey: value[0], jobId: value[1], scheduledSlotMs: value[2] };
    }
  } catch {
    // Old opaque IDs cannot recover a timed request.
  }
  return undefined;
}
