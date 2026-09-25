import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export function admitTestReplyTurn(
  overrides: Omit<Parameters<typeof admitReplyTurn>[0], "kind" | "resetTriggered"> &
    Partial<Pick<Parameters<typeof admitReplyTurn>[0], "kind" | "resetTriggered">>,
) {
  return admitReplyTurn({ kind: "visible", resetTriggered: false, ...overrides });
}

export function createSessionStore(entries: Record<string, SessionEntry>): string {
  const root = tempDirs.make("openclaw-reply-admission-");
  // The store handle stays a sessions.json path; the sqlite-backed accessor
  // resolves it to the per-agent DB, so fixtures must seed through the accessor.
  const storePath = path.join(root, "sessions.json");
  for (const [sessionKey, entry] of Object.entries(entries)) {
    replaceSessionEntrySync({ sessionKey, storePath }, entry);
  }
  return storePath;
}

export function createSessionStoreFor(sessionKey: string, sessionId: string) {
  return createSessionStore({ [sessionKey]: { sessionId, updatedAt: Date.now() } });
}
