import { afterEach, describe, expect, it } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "../config/sessions/store-maintenance-operations.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { parentRowFactsFromEntry } from "../cron/execution-context-admission.js";
import { classifyScheduledParent, resolveScheduledPrincipal } from "../cron/execution-context.js";
import type { CronStoredJob } from "../cron/types.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const chatKey = "agent:main:dashboard:00000000-0000-4000-8000-000000000001";
const otherKey = "agent:main:dashboard:00000000-0000-4000-8000-000000000002";
const storePath = "/tmp/openclaw-sessions/automation-parent-maintenance.json";

type Maintenance = NonNullable<
  Parameters<typeof applyFileBackedSessionStoreMaintenance>[0]["maintenanceConfig"]
>;
const off: Maintenance = {
  mode: "enforce",
  pruneAfterMs: 365 * DAY_MS,
  maxEntries: 500,
  archiveDashboardAfterMs: null,
  modelRunPruneAfterMs: DAY_MS,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};
const phases: [string, Partial<Maintenance>, string][] = [
  ["stale-dashboard", { archiveDashboardAfterMs: 7 * DAY_MS }, "stale-dashboard"],
  ["pruneAfter", { pruneAfterMs: 30 * DAY_MS }, "age-retention"],
  ["maxEntries", { maxEntries: 1 }, "active-session-cap"],
];

function parentJob(enabled: boolean): CronStoredJob {
  return {
    id: "hourly-report",
    enabled,
    sessionTarget: "isolated",
    sourceConversation: { sessionKey: chatKey, sessionId: "chat-session" },
  } as CronStoredJob;
}

async function maintain(jobs: CronStoredJob[], overrides: Partial<Maintenance>) {
  registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
  const now = Date.now();
  const store: Record<string, SessionEntry> = {
    [chatKey]: { sessionId: "chat-session", updatedAt: now - 40 * DAY_MS },
    [otherKey]: { sessionId: "other-session", updatedAt: now - 35 * DAY_MS },
  };
  await applyFileBackedSessionStoreMaintenance({
    store,
    storePath,
    maintenanceConfig: { ...off, ...overrides },
    log: { warn: () => {}, info: () => {} },
    artifacts: {
      archiveRemovedSessionTranscripts: async () => new Set<string>(),
      cleanupArchivedSessionTranscripts: async () => {},
    },
  });
  return store;
}

/** The occurrence admission classification that pauses a job whose parent was archived. */
function nextOccurrenceParentState(job: CronStoredJob, entry: SessionEntry | undefined) {
  const principal = resolveScheduledPrincipal(job, { trigger: "cron", agentId: "main" });
  if ("error" in principal || principal.kind !== "parent") {
    throw new Error("expected a parent-linked job");
  }
  return classifyScheduledParent(principal.parent, parentRowFactsFromEntry(entry, false));
}

afterEach(() => {
  registerSessionAutomationSource(null);
});

describe.each(phases)("%s maintenance", (_phase, overrides, archiveReason) => {
  // Under maxEntries a protected chat still counts toward the cap, like a pinned chat.
  it("keeps an idle chat whose enabled automation it created, so the job keeps running", async () => {
    const job = parentJob(true);
    const store = await maintain([job], overrides);
    expect(store[chatKey]?.archivedAt).toBeUndefined();
    expect(job.enabled).toBe(true);
    expect(nextOccurrenceParentState(job, store[chatKey])).toBe("current");
    expect(store[otherKey]).toMatchObject({ archiveReason });
  });

  it.each([
    ["a disabled automation", [parentJob(false)]],
    ["no automation", []],
  ])("archives the idle chat with %s as before", async (_label, jobs) => {
    const store = await maintain(jobs, overrides);
    expect(store[chatKey]).toMatchObject({ archivedAt: expect.any(Number), archiveReason });
  });
});
