import { afterEach, describe, expect, it } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "../config/sessions/store-maintenance-operations.js";
import { assertMaintenancePreservationCompatible } from "../config/sessions/store-maintenance-preserve-snapshot.js";
import { prepareSessionMaintenancePreservation } from "../config/sessions/store-maintenance-preserve.js";
import {
  type ResolvedSessionMaintenanceConfig,
  resolveMaintenanceConfigFromInput,
} from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  expectSessionAutomationSource,
  markSessionAutomationSourceUnavailable,
  registerSessionAutomationSource,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";

const DAY = 24 * 60 * 60 * 1000;
const storePath = "/synthetic/agents/main/sessions/sessions.json";
const cfg: OpenClawConfig = { session: { mainKey: "home" } };
const parent = "agent:main:dashboard:parent";
const delivery = "agent:main:dashboard:delivery";
const target = "agent:main:dashboard:target";
const other = "agent:main:dashboard:other";
const protectedKeys = [parent, delivery, target, "agent:main:home", "agent:main:cron:isolated"];
const phases = [
  ["dashboard", { archiveDashboardAfterMs: 7 * DAY }, "stale-dashboard"],
  ["age", { pruneAfterMs: 30 * DAY }, "age-retention"],
  ["cap", { maxEntries: protectedKeys.length }, "active-session-cap"],
] as const;
const off: ResolvedSessionMaintenanceConfig = {
  ...resolveMaintenanceConfigFromInput({ maxDiskBytes: false }),
  pruneAfterMs: 365 * DAY,
  archiveDashboardAfterMs: null,
  maxEntries: 500,
};

function jobs(enabled = true): CronJob[] {
  return [
    {
      id: "isolated",
      enabled,
      sessionTarget: "isolated",
      sessionKey: delivery,
      sourceConversation: { sessionKey: parent, sessionId: "parent-session" },
    },
    { id: "main", enabled, sessionTarget: "main" },
    { id: "named", enabled, sessionTarget: `session:${target}` },
  ] as CronJob[];
}

function source(currentJobs: readonly CronJob[] | undefined, config = cfg) {
  return { getJobs: () => currentJobs, getDefaultAgentId: () => "main", getConfig: () => config };
}

async function maintain(overrides: Partial<typeof off>) {
  const store: Record<string, SessionEntry> = Object.fromEntries(
    [...protectedKeys, other].map((key, index) => [
      key,
      { sessionId: `session-${index}`, updatedAt: Date.now() - (40 - index) * DAY },
    ]),
  );
  await applyFileBackedSessionStoreMaintenance({
    store,
    storePath,
    maintenanceConfig: { ...off, ...overrides },
    log: { warn() {}, info() {} },
    artifacts: {
      archiveRemovedSessionTranscripts: async () => new Set<string>(),
      cleanupArchivedSessionTranscripts: async () => {},
    },
  });
  return store;
}

afterEach(() => registerSessionAutomationSource(null));

describe.each(phases)("%s automation maintenance", (_phase, overrides, archiveReason) => {
  it("preserves every enabled release binding, not just the creating conversation", async () => {
    registerSessionAutomationSource(source(jobs()));
    const store = await maintain(overrides);
    for (const key of protectedKeys) {
      expect(store[key], key).toBeDefined();
      expect(store[key]?.archivedAt, key).toBeUndefined();
    }
    expect(store[other]).toMatchObject({ archiveReason });
  });

  it.each(["disabled", "removed"] as const)("releases %s job bindings", async (state) => {
    registerSessionAutomationSource(source(state === "disabled" ? jobs(false) : []));
    const store = await maintain(overrides);
    expect(store[parent]).toMatchObject({ archiveReason });
  });

  it("defers archives for unavailable jobs, then uses the loaded snapshot", async () => {
    expectSessionAutomationSource(cfg, true);
    const pending = await maintain(overrides);
    expect(pending[parent]?.archivedAt).toBeUndefined();
    expect(pending[other]?.archivedAt).toBeUndefined();
    registerSessionAutomationSource(source(jobs()));
    expect((await maintain(overrides))[other]).toMatchObject({ archiveReason });
  });
});

it("keeps replacement failures unavailable despite stale completion and stop", async () => {
  const predecessor = source(jobs());
  const oldEpoch = expectSessionAutomationSource(cfg, true);
  registerSessionAutomationSource(predecessor, oldEpoch);
  const nextEpoch = expectSessionAutomationSource(cfg, true);
  markSessionAutomationSourceUnavailable(nextEpoch);
  unregisterSessionAutomationSource(predecessor);
  registerSessionAutomationSource(predecessor, oldEpoch);
  const prepared = await prepareSessionMaintenancePreservation(storePath);
  try {
    expect(prepared.capture().deferArchiving).toBe(true);
    registerSessionAutomationSource(source([]), nextEpoch);
    expect(prepared.capture().deferArchiving).toBeUndefined();
    markSessionAutomationSourceUnavailable(oldEpoch);
    expect(prepared.capture().deferArchiving).toBeUndefined();
    expectSessionAutomationSource(cfg, true);
    const disabledEpoch = expectSessionAutomationSource(cfg, false);
    markSessionAutomationSourceUnavailable(disabledEpoch);
    expect(prepared.capture().deferArchiving).toBeUndefined();
  } finally {
    prepared.dispose();
  }
});

it("qualifies global bindings by physical store owner and honors the job agent", async () => {
  const globalConfig: OpenClawConfig = { session: { scope: "global" } };
  registerSessionAutomationSource(
    source(
      [{ id: "work-main", enabled: true, agentId: "work", sessionTarget: "main" } as CronJob],
      globalConfig,
    ),
  );
  const main = await prepareSessionMaintenancePreservation(storePath);
  const work = await prepareSessionMaintenancePreservation(
    "/synthetic/agents/work/sessions/sessions.json",
  );
  try {
    expect(main.capture().providerKeys).not.toContain("global");
    expect(work.capture().providerKeys).toContain("global");
  } finally {
    work.dispose();
    main.dispose();
  }
});

it("invalidates archive plans when a loaded snapshot becomes unavailable, but allows deletion-only plans", async () => {
  const epoch = expectSessionAutomationSource(cfg, true);
  registerSessionAutomationSource(source([]), epoch);
  const prepared = await prepareSessionMaintenancePreservation(storePath);
  try {
    const sent = prepared.capture();
    markSessionAutomationSourceUnavailable(epoch);
    const current = prepared.refreshCandidates([parent]);
    const plan = {
      archivedEntries: [{ sessionKey: parent }],
      entryRemovals: [],
      stateDeletePlans: [],
    };
    expect(() => assertMaintenancePreservationCompatible(sent, current, [plan])).toThrow(
      "session maintenance",
    );
    expect(() =>
      assertMaintenancePreservationCompatible(sent, current, [
        {
          archivedEntries: [],
          entryRemovals: [{ sessionKey: "agent:main:subagent:disposable" }],
          stateDeletePlans: [],
        },
      ]),
    ).not.toThrow();
  } finally {
    prepared.dispose();
  }
});
