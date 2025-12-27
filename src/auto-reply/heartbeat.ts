import { HEARTBEAT_TOKEN } from "./tokens.js";

export const HEARTBEAT_PROMPT = "HEARTBEAT";

export function stripHeartbeatToken(raw?: string) {
  if (!raw) return { shouldSkip: true, text: "" };
  const trimmed = raw.trim();
  if (!trimmed) return { shouldSkip: true, text: "" };
  if (trimmed.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: true, text: "" };
  }
  return { shouldSkip: false, text: trimmed };
}
