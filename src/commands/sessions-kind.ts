import type { RuntimeEnv } from "../runtime.js";

export const SESSION_KINDS = ["direct", "group", "global", "unknown"] as const;

export type SessionKind = (typeof SESSION_KINDS)[number];

export function resolveSessionKinds(
  rawKinds: string[] | undefined,
  runtime: RuntimeEnv,
): Set<SessionKind> | null {
  if (!rawKinds || rawKinds.length === 0) {
    return null;
  }
  const kinds = new Set<SessionKind>();
  for (const rawEntry of rawKinds) {
    for (const piece of rawEntry.split(",")) {
      const kind = piece.trim().toLowerCase();
      if (!kind) {
        continue;
      }
      if (!SESSION_KINDS.includes(kind as SessionKind)) {
        runtime.error(`--kind must be one of: ${SESSION_KINDS.join(", ")}`);
        runtime.exit(1);
        return null;
      }
      kinds.add(kind as SessionKind);
    }
  }
  if (kinds.size === 0) {
    runtime.error(`--kind must include at least one value: ${SESSION_KINDS.join(", ")}`);
    runtime.exit(1);
    return null;
  }
  return kinds;
}
