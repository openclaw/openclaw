import { vi } from "vitest";
import type { readRetainedSessionEntryFacts } from "../../config/sessions/session-entry-read-facts.js";

const sessionWorkspaceMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));

export { sessionWorkspaceMocks };

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: sessionWorkspaceMocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: sessionWorkspaceMocks.resolveDefaultAgentId,
}));

vi.mock("../../config/sessions/session-entry-read-facts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-entry-read-facts.js")>();
  return {
    ...actual,
    readRetainedSessionEntryFacts: createRepositorySessionEntryReader(
      actual.readRetainedSessionEntryFacts,
      (key) => sessionWorkspaceMocks.loadSessionEntry(key),
    ),
  };
});

type SessionEntryReader = typeof readRetainedSessionEntryFacts;
type LoadedSessionEntry = {
  agentId: string;
  canonicalKey: string;
  storePath: string;
  entry: NonNullable<ReturnType<SessionEntryReader>>["entries"][number]["entry"];
};

function createRepositorySessionEntryReader(
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
