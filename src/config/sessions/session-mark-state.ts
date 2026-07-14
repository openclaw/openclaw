import type { SessionEntry } from "./types.js";

export function resolveSessionMarkState(
  entry: SessionEntry | undefined,
): Pick<SessionEntry, "markLanguage" | "sessionMark"> {
  return {
    markLanguage: entry?.markLanguage,
    sessionMark: entry?.sessionMark,
  };
}
