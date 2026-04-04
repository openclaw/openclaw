type ThreadInputOpts = {
  threadId?: unknown;
  channel?: unknown;
  to?: unknown;
  [key: string]: unknown;
};

export type NormalizedThreadInputs = {
  hasThreadId: boolean;
  threadId?: string;
  explicitChannelProvided: boolean;
  explicitChannel?: string;
  explicitToProvided: boolean;
  explicitTo?: string;
};

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isNonMainSessionTarget(target: string | undefined): boolean {
  if (!target) {
    return false;
  }
  if (target === "isolated" || target === "current") {
    return true;
  }
  const trimmedTarget = target.trim();
  return (
    trimmedTarget.slice(0, 8).toLowerCase() === "session:" &&
    trimmedTarget.slice(8).trim().length > 0
  );
}

export function normalizeThreadIdInputs(opts: ThreadInputOpts): NormalizedThreadInputs {
  const hasThreadId = typeof opts.threadId === "string";
  const hasExplicitChannel = typeof opts.channel === "string";
  const hasExplicitTo = typeof opts.to === "string";

  return {
    hasThreadId,
    threadId: normalizeOptionalTrimmedString(opts.threadId),
    explicitChannelProvided: hasExplicitChannel,
    explicitChannel: normalizeOptionalTrimmedString(opts.channel),
    explicitToProvided: hasExplicitTo,
    explicitTo: normalizeOptionalTrimmedString(opts.to),
  };
}

export function assertValidThreadIdValue(threadId: string | undefined) {
  if (!threadId || !/^\d+$/.test(threadId)) {
    throw new Error("--thread-id must be a non-empty numeric value");
  }
}

export function composeThreadDeliveryTarget(to: string, threadId: string): string {
  return `${stripTelegramTopicSuffix(to)}:topic:${threadId}`;
}

export function stripTelegramTopicSuffix(to: string): string {
  return to.replace(/:topic:\d+$/i, "");
}
