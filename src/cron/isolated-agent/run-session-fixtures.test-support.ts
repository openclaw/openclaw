import type { SessionEntry } from "../../config/sessions/types.js";

// Central mock harness for isolated cron agent run orchestration tests.
type CronSessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent: boolean;
  skillsSnapshot: unknown;
  model?: string;
  modelProvider?: string;
  cliSessionBindings?: SessionEntry["cliSessionBindings"];
  [key: string]: unknown;
};

type CronSession = {
  storePath: string;
  store: Record<string, unknown>;
  sessionEntry: CronSessionEntry;
  lifecycleRevision: string;
  systemSent: boolean;
  isNewSession: boolean;
  [key: string]: unknown;
};

export function makeCronSessionEntry(overrides?: Record<string, unknown>): CronSessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: 0,
    systemSent: false,
    skillsSnapshot: undefined,
    ...overrides,
  };
}

export function makeCronSession(overrides?: Record<string, unknown>): CronSession {
  const session = {
    storePath: "/tmp/store.json",
    store: {},
    sessionEntry: makeCronSessionEntry(),
    lifecycleRevision: "test-lifecycle-revision",
    initialSessionEntry: undefined,
    systemSent: false,
    isNewSession: true,
    ...overrides,
  } as CronSession;
  // Real resolveCronSession stamps the run's lifecycleRevision onto the live
  // sessionEntry so the accessor-backed persist path can prove ownership on
  // later writes. Mirror that here unless a test seeds its own revision.
  if (session.sessionEntry.lifecycleRevision === undefined) {
    session.sessionEntry.lifecycleRevision = session.lifecycleRevision;
  }
  return session;
}
