import "./user-turn-transcript.js";
import fs from "node:fs";
import path from "node:path";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import type {
  PersistUserTurnTranscriptParams,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptTarget,
} from "./user-turn-transcript.types.js";

type UserTurnTranscriptTestApi = {
  persistUserTurnTranscript(
    params: PersistUserTurnTranscriptParams,
  ): Promise<UserTurnTranscriptPersistResult | undefined>;
};

function getTestApi(): UserTurnTranscriptTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.userTurnTranscriptTestApi")
  ] as UserTurnTranscriptTestApi;
}

export async function persistUserTurnTranscript(
  params: PersistUserTurnTranscriptParams,
): Promise<UserTurnTranscriptPersistResult | undefined> {
  return await getTestApi().persistUserTurnTranscript(params);
}

export function createSqliteTranscriptTarget(params: {
  dir: string;
  sessionId?: string;
  sessionKey?: string;
}) {
  const sessionId = params.sessionId ?? "session-1";
  const sessionKey = params.sessionKey ?? "agent:main:main";
  const storePath = path.join(params.dir, "agents", "main", "sessions", "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const sqliteMarker = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  return {
    agentId: "main",
    cwd: params.dir,
    sessionEntry: undefined,
    sessionId,
    sessionKey,
    storePath,
    sqliteMarker,
  };
}

export async function readTranscriptMessages(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<Record<string, unknown>>> {
  return (
    await loadTranscriptEvents({
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    })
  )
    .map((entry) => (entry as { message?: unknown }).message)
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null,
    );
}

/** Creates a store-backed transcript target for tests that do not own runtime session setup. */
export function createTestUserTurnTranscriptTarget(
  overrides: Partial<UserTurnTranscriptTarget> = {},
): UserTurnTranscriptTarget {
  return {
    agentId: "main",
    sessionEntry: undefined,
    sessionId: "test-session",
    sessionKey: "agent:main:test",
    ...overrides,
  };
}
