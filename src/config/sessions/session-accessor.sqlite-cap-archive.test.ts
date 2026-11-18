import { expect, it, onTestFinished } from "vitest";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  patchSessionEntryCore,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { InternalSessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const fixture = useTempSessionsFixture("openclaw-sqlite-cap-archive-");

it("persists reasons and caps the least-recently-touched active row after dashboard archival", async () => {
  const storePath = fixture.storePath();
  const now = Date.now();
  const scope = (key: string) => ({ sessionKey: `agent:main:${key}`, storePath });
  const load = (key: string) => loadSessionEntry(scope(key));
  const preservedMetadata = {
    sandbox: "required",
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: "maintenance-creator" },
    createdAt: now - 50 * DAY_MS,
    publicShare: { id: "a".repeat(48), sessionId: "ordinary-aged", createdAt: now - DAY_MS },
    skillsSnapshot: { prompt: "Preserve the complete saved prompt", skills: [] },
  } satisfies Partial<InternalSessionEntry>;
  const entries = {
    "ordinary:aged": {
      sessionId: "ordinary-aged",
      updatedAt: now - 40 * DAY_MS,
      archivedBy: { type: "human", id: "previous-archiver" },
      ...preservedMetadata,
    },
    "dashboard:stale": { sessionId: "dashboard-stale", updatedAt: now - 40 * DAY_MS },
    "ordinary:recently-touched": {
      sessionId: "recently-touched",
      updatedAt: now - 20 * DAY_MS,
      lastInteractionAt: now - DAY_MS,
    },
    "ordinary:least-recently-touched": {
      sessionId: "least-recently-touched",
      updatedAt: now - 10 * DAY_MS,
      lastActivityAt: now - 30 * DAY_MS,
    },
    "ordinary:trigger": { sessionId: "trigger", updatedAt: now },
  } satisfies Record<string, InternalSessionEntry>;
  for (const [key, entry] of Object.entries(entries)) {
    await patchSessionEntryCore(scope(key), () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }
  const result = await applySessionEntryLifecycleMutation({
    storePath,
    maintenanceOverride: {
      archiveDashboardAfterMs: 7 * DAY_MS,
      maxEntries: 2,
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
    },
  });
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    path: resolveSqliteTargetFromSessionStorePath(storePath).path,
  });
  // Fixture cleanup must close this owner before another test changes ambient state.
  onTestFinished(() => {
    try {
      expect(database.db.isOpen).toBe(false);
    } finally {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
  });
  expect(result).toMatchObject({ archived: 3, capArchived: 1, capped: 1, pruned: 0 });
  expect(load("ordinary:aged")).toMatchObject({
    ...preservedMetadata,
    sessionId: "ordinary-aged",
    updatedAt: now - 40 * DAY_MS,
    archivedAt: expect.any(Number),
    archiveReason: "age-retention",
  });
  expect(load("ordinary:aged")?.archivedBy).toBeUndefined();
  expect(load("dashboard:stale")).toMatchObject({
    archivedAt: expect.any(Number),
    archiveReason: "stale-dashboard",
  });
  expect(load("ordinary:least-recently-touched")).toMatchObject({
    archivedAt: expect.any(Number),
    archiveReason: "active-session-cap",
  });
  expect(load("ordinary:recently-touched")?.archivedAt).toBeUndefined();
  expect(load("ordinary:trigger")?.archivedAt).toBeUndefined();
});
