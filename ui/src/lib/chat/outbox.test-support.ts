import type { ChatQueueItem } from "./chat-types.ts";
import type { StoredComposerSession, StoredComposerState } from "./outbox-store-codec.ts";
import type { storageTargetForGateway } from "./outbox-store.ts";

export const storedSession = (overrides: Partial<StoredComposerSession> = {}, updatedAt = 1) => ({
  updatedAt,
  ...overrides,
});

export const queued = (id: string, overrides: Partial<ChatQueueItem> = {}): ChatQueueItem => ({
  id,
  text: id,
  createdAt: 1,
  ...overrides,
});

export const draftSession = (draft: string, revision: number) =>
  storedSession({ draft, draftRevision: revision, updatedAt: revision });

export const privateInput = () => ({
  draft: "@Alex private legacy input",
  draftMentions: [{ profileId: "alex", start: 0, end: 5 }],
  goalMode: { action: "start", sessionId: "private-goal" },
});

export const recoveryRow = (
  sourceScopeKey: string,
  session: StoredComposerState["sessions"][string],
  sourceVersion: 1 | 2 | 3 | 4 = 4,
) => ({ sourceVersion, sourceScopeKey, session });
export const recoveryRows = (make: (index: number) => ReturnType<typeof recoveryRow>) =>
  Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`row-${index}`, make(index)]));

export function seedStore(
  target: ReturnType<typeof storageTargetForGateway>,
  sessions: StoredComposerState["sessions"],
  recovery: StoredComposerState["recovery"] = {},
) {
  const store = { version: 4, gatewayOwner: target.gatewayOwner, sessions, recovery };
  sessionStorage.setItem(target.key, JSON.stringify(store));
  return store;
}

export function seedSource(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  const key = [target.legacyKey, target.previousKey, target.blobKey, target.key][version - 1]!;
  const source = sourceJson(target, version, sessions);
  sessionStorage.setItem(key, source);
  return { key, source };
}

export function sourceJson(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  return JSON.stringify({
    version,
    gatewayOwner: version === 1 ? undefined : target.gatewayOwner,
    recovery: version === 4 ? {} : undefined,
    sessions,
  });
}
