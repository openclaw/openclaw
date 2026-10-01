import type { SessionEntry } from "./types.js";

/**
 * Legacy command shim: runtime storage uses the returned session key only as a
 * process-local routing token; SQLite identity travels separately.
 */
export async function resolveSessionTranscriptFile(params: {
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  return {
    sessionFile: params.sessionKey,
    sessionEntry: params.sessionEntry ?? params.sessionStore?.[params.sessionKey],
  };
}
