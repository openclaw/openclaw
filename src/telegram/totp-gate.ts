import type { TelegramTotpConfig } from "../config/types.telegram.js";
import {
  checkRateLimit,
  hasValidSession,
  isUserEnrolled,
  verifyAndCreateSession,
} from "../totp/totp-store.js";

const DEFAULT_SESSION_DURATION = 86_400; // 24h
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RATE_LIMIT_WINDOW = 300; // 5 min

export type TotpGateResult =
  | { action: "pass" }
  | { action: "prompt" }
  | { action: "verified" }
  | { action: "rejected" }
  | { action: "rate_limited" };

const CODE_PATTERN = /^\d{6}$/;

export async function checkTotpGate(params: {
  telegramUserId: string;
  messageText: string;
  totpConfig: TelegramTotpConfig;
}): Promise<TotpGateResult> {
  const { telegramUserId, messageText, totpConfig } = params;
  const sessionDuration = totpConfig.sessionDurationSeconds ?? DEFAULT_SESSION_DURATION;
  const maxAttempts = totpConfig.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const rateLimitWindow = totpConfig.rateLimitWindowSeconds ?? DEFAULT_RATE_LIMIT_WINDOW;

  // Not enrolled -> pass through
  const enrolled = await isUserEnrolled(telegramUserId);
  if (!enrolled) {
    return { action: "pass" };
  }

  // Has valid session -> pass through
  const valid = await hasValidSession(telegramUserId);
  if (valid) {
    return { action: "pass" };
  }

  // Message looks like a 6-digit TOTP code
  const trimmed = messageText.trim();
  if (CODE_PATTERN.test(trimmed)) {
    // Check rate limit first
    const allowed = await checkRateLimit(telegramUserId, maxAttempts, rateLimitWindow);
    if (!allowed) {
      return { action: "rate_limited" };
    }

    const verified = await verifyAndCreateSession(
      telegramUserId,
      trimmed,
      sessionDuration,
      maxAttempts,
      rateLimitWindow,
    );
    return verified ? { action: "verified" } : { action: "rejected" };
  }

  // Not a code -> prompt for authentication
  return { action: "prompt" };
}
