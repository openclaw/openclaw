import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type SkillResearchAutoCaptureSessionContext = {
  sessionId?: string;
  sessionKey?: string;
};

export function shouldSkipSkillResearchAutoCaptureSession(
  ctx: SkillResearchAutoCaptureSessionContext,
): boolean {
  const sessionId = normalizeOptionalString(ctx.sessionId);
  if (sessionId?.startsWith("active-memory-")) {
    return true;
  }

  const sessionKey = normalizeOptionalString(ctx.sessionKey);
  return sessionKey?.includes(":active-memory:") === true;
}
