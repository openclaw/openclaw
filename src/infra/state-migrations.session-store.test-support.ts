import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

export async function drainSessionMigrationFixture(root: string): Promise<void> {
  await closeOpenClawAgentDatabasesAsync(root);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

export function createLegacyAcpSessionEntry(
  sessionId: string,
  updatedAt: number,
  agent: string,
  runtimeSessionName: string,
  lastActivityAt: number,
) {
  return {
    sessionId,
    updatedAt,
    acp: {
      backend: "test",
      agent,
      runtimeSessionName,
      mode: "persistent",
      state: "idle",
      lastActivityAt,
    } satisfies SessionAcpMeta,
  };
}

export function writeLegacySessionsFixture(params: {
  root: string;
  sessions: Record<string, Record<string, unknown> & { sessionId: string; updatedAt: number }>;
  transcripts?: Record<string, string>;
}) {
  const legacySessionsDir = path.join(params.root, "sessions");
  fs.mkdirSync(legacySessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacySessionsDir, "sessions.json"),
    JSON.stringify(params.sessions, null, 2),
    "utf-8",
  );
  for (const [fileName, content] of Object.entries(params.transcripts ?? {})) {
    fs.writeFileSync(path.join(legacySessionsDir, fileName), content, "utf-8");
  }
  return legacySessionsDir;
}

export function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "worker-1", default: true }],
    },
    session: {
      mainKey: "desk",
    },
    channels: {
      chatapp: {
        defaultAccount: "alpha",
        accounts: {
          beta: {},
          alpha: {},
        },
      },
    },
  } as OpenClawConfig;
}
