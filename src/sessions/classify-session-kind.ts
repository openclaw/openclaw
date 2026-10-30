import { isCronSessionKey } from "./session-key-utils.js";

export type SessionKind = "cron" | "direct" | "group" | "global" | "spawn-child" | "unknown";

export function classifySessionKind(
  key: string,
  entry?: { chatType?: string | null; spawnedBy?: string | null },
): SessionKind {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (isCronSessionKey(key)) {
    return "cron";
  }
  // Spawn ancestry precedes key shape: child ACP sessions can have opaque direct-like keys.
  if (entry?.spawnedBy) {
    return "spawn-child";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}
