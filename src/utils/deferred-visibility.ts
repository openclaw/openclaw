export type DeferredVisibility = "internal" | "summary-only" | "user-visible";

export type DeferredExecutionPayload = {
  visibility: "internal";
  agentPrompt: string;
};

export type SummaryOnlyDeferredDisplayPayload = {
  visibility: "summary-only";
  text?: string;
  summaryLine?: string;
};

export type UserVisibleDeferredDisplayPayload = {
  visibility: "user-visible";
  text?: string;
  summaryLine?: string;
};

export type DeferredDisplayPayload =
  | SummaryOnlyDeferredDisplayPayload
  | UserVisibleDeferredDisplayPayload;

export function hasDeferredDisplayContent(payload: DeferredDisplayPayload): boolean {
  return Boolean(payload.text?.trim() || payload.summaryLine?.trim());
}

export function isUserVisibleDeferredDisplayPayload(
  payload: DeferredDisplayPayload | undefined,
): payload is UserVisibleDeferredDisplayPayload {
  return payload?.visibility === "user-visible" && hasDeferredDisplayContent(payload);
}

export function assertDeferredDisplayPayload<T extends DeferredDisplayPayload>(
  payload: T | undefined,
  context = "deferred display payload",
): T {
  if (!payload) {
    throw new Error(`Missing ${context}`);
  }
  if (payload.visibility !== "summary-only" && payload.visibility !== "user-visible") {
    throw new Error(
      `Invalid ${context}: expected display visibility, got ${(payload as { visibility?: string }).visibility}`,
    );
  }
  if (payload.visibility === "summary-only") {
    if (!payload.summaryLine?.trim()) {
      throw new Error(`Invalid ${context}: summary-only payload requires summaryLine`);
    }
    return payload;
  }
  if (!hasDeferredDisplayContent(payload)) {
    throw new Error(`Invalid ${context}: missing text or summaryLine`);
  }
  return payload;
}

export function assertUserVisibleDeferredDisplayPayload(
  payload: DeferredDisplayPayload | undefined,
  context = "user-visible deferred display payload",
): UserVisibleDeferredDisplayPayload {
  const resolved = assertDeferredDisplayPayload(payload, context);
  if (resolved.visibility !== "user-visible") {
    throw new Error(
      `Invalid ${context}: expected visibility=user-visible, got ${resolved.visibility}`,
    );
  }
  return resolved;
}
