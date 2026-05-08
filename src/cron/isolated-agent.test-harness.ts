import path from "node:path";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { upsertSessionEntry } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { CronJob } from "./types.js";

export async function withTempCronHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      try {
        return await fn(home);
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
    { prefix: "openclaw-cron-" },
  );
}

function cronTestEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
  };
}

export async function seedMainRouteSession(
  home: string,
  session: { lastProvider: string; lastTo: string; lastChannel?: string },
): Promise<void> {
  await seedCronSessionRows(home, {
    "agent:main:main": {
      sessionId: "main-session",
      updatedAt: Date.now(),
      ...session,
    },
  });
}

export async function seedCronSessionRows(
  home: string,
  entries: Record<string, Record<string, unknown>>,
  agentId = "main",
): Promise<void> {
  const env = cronTestEnv(home);
  for (const [sessionKey, entry] of Object.entries(entries)) {
    upsertSessionEntry({
      agentId,
      env,
      sessionKey,
      entry: entry as SessionEntry,
    });
  }
}

export function makeCfg(home: string, overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  const base: OpenClawConfig = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: path.join(home, "openclaw"),
      },
    },
    session: {
      mainKey: "main",
    },
  } as OpenClawConfig;
  return { ...base, ...overrides };
}

export function makeJob(payload: CronJob["payload"]): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}
