import type { readRetainedSessionEntryFacts } from "../../config/sessions/session-entry-read-facts.js";

type SessionEntryReader = typeof readRetainedSessionEntryFacts;
type LoadedSessionEntry = {
  agentId: string;
  canonicalKey: string;
  storePath: string;
  entry: NonNullable<ReturnType<SessionEntryReader>>["entries"][number]["entry"];
};

export function createRepositorySessionEntryReader(
  readActual: SessionEntryReader,
  load: (sessionKey?: string) => LoadedSessionEntry | undefined,
): SessionEntryReader {
  return (database, request, owner) => {
    const loaded = load(request.sessionKeys?.[0]);
    if (
      !loaded ||
      database.agentId !== loaded.agentId ||
      database.path !== loaded.storePath ||
      !request.sessionKeys?.includes(loaded.canonicalKey)
    ) {
      return readActual(database, request, owner);
    }
    return {
      kind: "session-exact-entries",
      entries: [{ sessionKey: loaded.canonicalKey, entry: loaded.entry }],
      lifecycleTimestamps: {},
      source: { ...database, databaseIdentity: "repository-files-fixture" },
      databaseIdentity: {
        identity: "repository-files-fixture",
        incarnation: "repository-files-fixture",
        filename: database.path,
      },
    };
  };
}
