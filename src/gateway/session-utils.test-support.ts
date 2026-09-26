import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

export function seedSessionEntries(storePath: string, entries: Record<string, SessionEntry>): void {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    replaceSessionEntrySync({ sessionKey, storePath }, entry);
  }
}

export function appendTranscriptMessages(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
  messages: unknown[];
  agentId?: string;
}) {
  for (const message of params.messages) {
    appendTranscriptMessageSync(
      {
        agentId: params.agentId ?? "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      { message },
    );
  }
}

export function createSingleAgentAvatarConfig(workspace: string): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    agents: {
      list: [{ id: "main", default: true, workspace, identity: { avatar: "avatar-link.png" } }],
    },
  } as OpenClawConfig;
}

export function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, { agentRuntime?: { id: string } }>;
  agentRuntime?: { id: string };
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: {
          ...params.models,
          ...(params.agentRuntime
            ? { [params.primary]: { agentRuntime: params.agentRuntime } }
            : {}),
        },
      },
    },
  } as OpenClawConfig;
}
