import { afterEach, describe, expect, it } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "../config/sessions/store-maintenance-operations.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { parentRowFactsFromEntry } from "../cron/execution-context-admission.js";
import { classifyScheduledParent, resolveScheduledPrincipal } from "../cron/execution-context.js";
import type { CronStoredJob } from "../cron/types.js";
import {
  expectSessionAutomationSource,
  registerSessionAutomationSource,
  reportSessionAutomationSourceLoadFailed,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";

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

const subagentKey = "agent:main:subagent:00000000-0000-4000-8000-000000000003";

function registerJobs(jobs: CronStoredJob[]) {
  registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
}

async function maintain(jobs: CronStoredJob[] | "not-loaded", overrides: Partial<Maintenance>) {
  if (jobs !== "not-loaded") {
    registerJobs(jobs);
  }
  const now = Date.now();
  const store: Record<string, SessionEntry> = {
    [chatKey]: { sessionId: "chat-session", updatedAt: now - 40 * DAY_MS },
    [otherKey]: { sessionId: "other-session", updatedAt: now - 35 * DAY_MS },
    [subagentKey]: { sessionId: "subagent-session", updatedAt: now - 35 * DAY_MS },
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
  // Registration settles any pending load before the next test.
  registerJobs([]);
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

describe.each(phases)("%s maintenance before cron loads", (_phase, overrides, archiveReason) => {
  it("defers archiving until the Gateway's cron jobs register, then protects the parent", async () => {
    expectSessionAutomationSource();
    const pending = await maintain("not-loaded", overrides);
    expect(pending[chatKey]?.archivedAt).toBeUndefined();
    expect(pending[otherKey]?.archivedAt).toBeUndefined();
    if (overrides.pruneAfterMs !== undefined) {
      // Disposable runtime rows are still pruned; only archiving waits.
      expect(pending[subagentKey]).toBeUndefined();
    }

    const loaded = await maintain([parentJob(true)], overrides);
    expect(loaded[chatKey]?.archivedAt).toBeUndefined();
    expect(loaded[otherKey]).toMatchObject({ archiveReason });
  });

  it("archives as before when no cron service will load", async () => {
    const store = await maintain("not-loaded", overrides);
    expect(store[chatKey]).toMatchObject({ archiveReason });
  });
});

it("keeps archiving paused after a failed cron load and warns once per process", async () => {
  expectSessionAutomationSource();
  expect(reportSessionAutomationSourceLoadFailed(new Error("store unavailable"))).toBe(true);
  expect(reportSessionAutomationSourceLoadFailed(new Error("store unavailable"))).toBe(false);
  const store = await maintain("not-loaded", { archiveDashboardAfterMs: 7 * DAY_MS });
  expect(store[chatKey]?.archivedAt).toBeUndefined();
  expect(store[otherKey]?.archivedAt).toBeUndefined();
});

it("keeps archiving deferred while a hot-reloaded cron service replaces a registered one", async () => {
  const jobs = [parentJob(true)];
  const predecessor = { getJobs: () => jobs, getDefaultAgentId: () => "main" };
  registerSessionAutomationSource(predecessor);
  // The replacement is built while the predecessor still serves, then the predecessor stops.
  expectSessionAutomationSource();
  unregisterSessionAutomationSource(predecessor);
  const reloading = await maintain("not-loaded", { archiveDashboardAfterMs: 7 * DAY_MS });
  expect(reloading[chatKey]?.archivedAt).toBeUndefined();
  expect(reloading[otherKey]?.archivedAt).toBeUndefined();

  const replaced = await maintain(jobs, { archiveDashboardAfterMs: 7 * DAY_MS });
  expect(replaced[chatKey]?.archivedAt).toBeUndefined();
  expect(replaced[otherKey]).toMatchObject({ archiveReason: "stale-dashboard" });
});
