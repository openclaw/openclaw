export const MAX_INJECTED_STEER_MESSAGE_CHARS = 4_000;
export const INJECTED_STEER_RATE_LIMIT_MS = 2_000;

export type SteerMessageInjectionRejectReason = "message_too_large" | "rate_limited";

const lastInjectedSteerMessageAtBySession = new Map<string, number>();

export function validateSteerMessageInjection(params: {
  sessionId: string;
  text: string;
  nowMs?: number;
  enforceRateLimit?: boolean;
}): { ok: true } | { ok: false; reason: SteerMessageInjectionRejectReason } {
  if (params.text.length > MAX_INJECTED_STEER_MESSAGE_CHARS) {
    return { ok: false, reason: "message_too_large" };
  }

  const enforceRateLimit = params.enforceRateLimit ?? process.env.VITEST !== "true";
  if (!enforceRateLimit) {
    return { ok: true };
  }

  const nowMs = params.nowMs ?? Date.now();
  const lastInjectedAt = lastInjectedSteerMessageAtBySession.get(params.sessionId) ?? 0;
  if (nowMs - lastInjectedAt < INJECTED_STEER_RATE_LIMIT_MS) {
    return { ok: false, reason: "rate_limited" };
  }
  lastInjectedSteerMessageAtBySession.set(params.sessionId, nowMs);
  return { ok: true };
}

export function resetSteerMessageInjectionPolicyForTests(): void {
  lastInjectedSteerMessageAtBySession.clear();
}
