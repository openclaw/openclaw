import type { SessionEntry } from "./types.js";

export function resolveSessionMarkState(
  entry: SessionEntry | undefined,
): Pick<SessionEntry, "sessionMark"> {
  return {
    sessionMark: entry?.sessionMark,
  };
}
