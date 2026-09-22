import { vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordSessionStateEvent } from "./session-state-events.js";

const tempDirs: string[] = [];
export const watcher = "agent:main:main";
export const nestedWatcher = "agent:main:subagent:parent";
export const child = "agent:main:subagent:child";

export function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-state-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

export function eventInput(
  overrides: Partial<Parameters<typeof recordSessionStateEvent>[0]> = {},
): Parameters<typeof recordSessionStateEvent>[0] {
  return {
    sessionKey: child,
    sessionId: "session-child",
    agentId: "main",
    kind: "human_direct_message",
    actorType: "human",
    summary: "human message via test",
    watcherSessionKeys: [watcher],
    ...overrides,
  };
}

export function readCursor(
  database: ReturnType<typeof createDatabaseOptions>,
  watcherSessionKey = watcher,
  targetSessionKey = child,
) {
  return openOpenClawStateDatabase(database)
    .db.prepare(
      `SELECT last_seen_sequence, notified_sequence, material_sequence
       FROM session_watch_cursors
       WHERE watcher_session_key = ? AND target_session_key = ?`,
    )
    .get(watcherSessionKey, targetSessionKey) as
    | {
        last_seen_sequence: number;
        notified_sequence: number;
        material_sequence: number;
      }
    | undefined;
}

export function seedChild(
  database: ReturnType<typeof createDatabaseOptions>,
  watcherSessionKey = watcher,
) {
  return recordSessionStateEvent(
    eventInput({
      kind: "child_spawned",
      actorType: "agent",
      actorId: watcherSessionKey,
      dedupeKey: `child-spawned:${watcherSessionKey}`,
      watcherSessionKeys: [watcherSessionKey],
    }),
    database,
  );
}

export async function cleanupSessionStateTestState() {
  vi.useRealTimers();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
  cleanupTempDirs(tempDirs);
  vi.unstubAllEnvs();
}
