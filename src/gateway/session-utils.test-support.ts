import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";

export async function closeSessionSqliteDatabasesForTest(): Promise<void> {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

export async function withStateDirEnv<T>(
  prefix: string,
  fn: (ctx: { tempRoot: string; stateDir: string }) => Promise<T>,
): Promise<T> {
  return withRawStateDirEnv(prefix, async (ctx) => {
    try {
      return await fn(ctx);
    } finally {
      await closeSessionSqliteDatabasesForTest();
    }
  });
}

export function useSessionStoreFixture(prefix: string): () => string {
  const tempDirs = createTempDirTracker();
  let storePath: string;
  beforeEach(() => {
    storePath = path.join(tempDirs.make(prefix), "sessions.json");
  });
  afterEach(async () => {
    await closeSessionSqliteDatabasesForTest();
    tempDirs.cleanup();
  });
  return () => storePath;
}
