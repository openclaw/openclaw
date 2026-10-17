import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { isRetainedSessionTranscriptArchiveName } from "./artifacts.js";
import { loadSessionEntry, loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import * as lifecycleProjection from "./session-accessor.sqlite-projection.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as entryReadRuntime from "./session-entry-read-maintenance.js";
import { runSessionRegistryMaintenanceForStore } from "./session-registry-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const fixtureSuite = createFixtureSuite("openclaw-session-registry-maintenance-");

beforeAll(() => fixtureSuite.setup());
afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await fixtureSuite.cleanup();
});

function maintain(
  storePath: string,
  options: Partial<Parameters<typeof runSessionRegistryMaintenanceForStore>[0]> = {},
) {
  return runSessionRegistryMaintenanceForStore({
    agentId: "main",
    storePath,
    apply: true,
    retentionMs: 7 * DAY_MS,
    runningCronJobIds: new Set(),
    ...options,
  });
}

const sessionEntry = (sessionId: string, updatedAt: number): SessionEntry => ({
  sessionId,
  updatedAt,
  delivery: { kind: "none" },
});
const staleEntry = (sessionId: string, extra: Partial<SessionEntry> = {}) => ({
  ...sessionEntry(sessionId, Date.now() - 8 * DAY_MS),
  ...extra,
});
const instructions = (prompt: string) => ({ prompt, skills: [] });
const emptySummary = { pruned: 0, preservedRunning: 0, nextSweepAtMs: null };
const event = { type: "proof-event", data: "cron transcript must survive" };
const applyRemoval = lifecycleProjection.applySessionEntryLifecycleMutation;
const spyRemoval = () => vi.spyOn(lifecycleProjection, "applySessionEntryLifecycleMutation");

function inspectPages(
  inspect: (
    page: Parameters<Parameters<typeof entryReadRuntime.withSessionRegistryEntriesInWorker>[1]>[0],
  ) => void,
) {
  const read = entryReadRuntime.withSessionRegistryEntriesInWorker;
  vi.spyOn(entryReadRuntime, "withSessionRegistryEntriesInWorker").mockImplementation(
    (scope, consume) =>
      read(scope, async (page, assertCurrent) => {
        inspect(page);
        await consume(page, assertCurrent);
      }),
  );
}

async function cronCase(name: string, extra: Partial<SessionEntry> = {}) {
  const sessionKey = `agent:main:cron:${name}:run:old`;
  const entry = staleEntry(name, extra);
  const storePath = await createStore({ [sessionKey]: entry });
  const scope = { sessionKey, sessionId: name, storePath };
  return {
    scope,
    entry,
    read: () => loadSessionEntry(scope),
    transcripts: () => loadTranscriptEvents(scope),
    archives: () => listDeletedArchiveFiles(path.dirname(storePath)),
  };
}

async function createStore(entries: Record<string, SessionEntry>): Promise<string> {
  const dir = await fixtureSuite.createCaseDir("store");
  const storePath = path.join(dir, "sessions.json");
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
  return storePath;
}

async function listDeletedArchiveFiles(root: string): Promise<string[]> {
  const archives: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (isRetainedSessionTranscriptArchiveName(entry.name)) {
        archives.push(fullPath);
      }
    }
  };
  await walk(root);
  return archives;
}

it("prunes bloated cron rows in bounded pages while preserving recent and running rows", async () => {
  const now = Date.now();
  const usageFamilySessionIds = Array.from({ length: 1024 }, (_, i) => `previous-run-${i}`);
  const staleKeys = Array.from({ length: 65 }, (_, i) => `agent:main:cron:done:run:${i}`);
  const recentKey = "agent:main:cron:done:run:recent";
  const runningKey = "agent:main:cron:running:run:old";
  const entries = Object.fromEntries(
    [...staleKeys, recentKey, runningKey].map((key) => [
      key,
      {
        ...sessionEntry(key, key === recentKey ? now : now - 8 * DAY_MS),
        usageFamilySessionIds,
      },
    ]),
  );
  const storePath = await createStore(entries);
  let seen = 0;
  inspectPages((page) => {
    seen += page.length;
    expect(page.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024);
  });
  const result = await maintain(storePath, { runningCronJobIds: new Set(["running"]) });
  expect(seen).toBe(67);
  expect(result).toMatchObject({ pruned: 65, preservedRunning: 1 });
  for (const sessionKey of staleKeys) {
    expect(loadSessionEntry({ storePath, sessionKey })).toBeUndefined();
  }
  for (const sessionKey of [recentKey, runningKey]) {
    expect(loadSessionEntry({ storePath, sessionKey })).toEqual(entries[sessionKey]);
  }
});

it("reports the next retention deadline and goes dormant after the final removal", async () => {
  const now = Date.now();
  const { scope, read } = await cronCase("deadline-recent", { updatedAt: now });
  expect((await maintain(scope.storePath)).nextSweepAtMs).toBe(now + 7 * DAY_MS + 1);
  await replaceSessionEntry(scope, sessionEntry(scope.sessionId, now - 8 * DAY_MS));
  expect(await maintain(scope.storePath)).toEqual({ ...emptySummary, pruned: 1 });
  expect(read()).toBeUndefined();
});

it("rechecks caller authority inside the removal transaction after planning", async () => {
  const { scope, read } = await cronCase("authority-old");
  let current = true;
  const mutation = spyRemoval().mockImplementation((params) => {
    current = false;
    return applyRemoval(params);
  });
  await expect(
    maintain(scope.storePath, {
      assertCurrent() {
        if (!current) {
          throw new Error("maintenance owner retired");
        }
      },
    }),
  ).rejects.toThrow("maintenance owner retired");
  expect(mutation).toHaveBeenCalledOnce();
  expect(read()?.sessionId).toBe("authority-old");
});
it("retains a cron session whose cold snapshot changes after pruning was planned", async () => {
  const { scope, entry, read, transcripts, archives } = await cronCase("changed-old", {
    skillsSnapshot: instructions("Original saved instructions"),
  });
  const changedEntry: SessionEntry = {
    ...entry,
    skillsSnapshot: instructions("Changed saved instructions"),
  };
  appendTranscriptEventSync(scope, event);
  const mutation = spyRemoval().mockImplementationOnce(async (params) => {
    await replaceSessionEntry(scope, changedEntry);
    return applyRemoval(params);
  });
  expect(await maintain(scope.storePath)).toMatchObject({ preservedRunning: 0, pruned: 0 });
  expect(mutation).toHaveBeenCalledOnce();
  expect(read()).toEqual(changedEntry);
  await expect(transcripts()).resolves.toEqual([event]);
  expect(await archives()).toEqual([]);
});

it("summarizes a missing store without creating it", async () => {
  const dir = await fixtureSuite.createCaseDir("missing-store");
  const storePath = path.join(dir, "sessions.json");
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
  if (!sqlitePath) {
    throw new Error(`Expected a SQLite target for ${storePath}`);
  }
  expect(await maintain(storePath)).toEqual(emptySummary);
  for (const file of [storePath, sqlitePath]) {
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("archives the transcript when pruning stale cron-run sessions", async () => {
  const { scope, read, transcripts, archives } = await cronCase("run-1", {
    skillsSnapshot: instructions("Cron instructions retained for the deletion guard"),
  });
  appendTranscriptEventSync(scope, event);
  expect(await maintain(scope.storePath)).toEqual({ ...emptySummary, pruned: 1 });
  expect(read()).toBeUndefined();
  const files = await archives();
  expect(files).toHaveLength(1);
  expect(readSessionArchiveContentSync(files[0] ?? "")).toContain(event.data);
  await expect(transcripts()).resolves.toEqual([]);
});

it("previews pruning without transferring or changing ordinary entries", async () => {
  const now = Date.now();
  const sessionKey = "agent:main:cron:done-job:run:old-run";
  const sessionId = "run-1";
  const ordinaryKey = "agent:main:dashboard:ordinary";
  const ordinaryEntry: SessionEntry = {
    ...sessionEntry("ordinary", now - 40 * DAY_MS),
    sessionDiffBaseline: {
      version: 1,
      sessionId: "ordinary",
      root: "/synthetic",
      files: [{ path: "README.md", fingerprint: "original" }],
    },
    skillsSnapshot: instructions("Ordinary saved instructions"),
    systemPromptReport: {
      source: "run",
      generatedAt: now,
      sessionId: "ordinary",
      systemPrompt: { chars: 27, projectContextChars: 0, nonProjectContextChars: 27 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 27, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    },
  };
  const storePath = await createStore({
    [sessionKey]: sessionEntry(sessionId, now - 8 * DAY_MS),
    [ordinaryKey]: ordinaryEntry,
  });
  appendTranscriptEventSync({ sessionKey, sessionId, storePath }, event);

  inspectPages((entries) => {
    expect(entries.map(({ sessionKey: key }) => key)).toEqual([sessionKey]);
  });
  const result = await maintain(storePath, { apply: false });

  expect(result).toMatchObject({ preservedRunning: 0, pruned: 1 });
  expect(loadSessionEntry({ sessionKey, storePath })).toEqual(
    sessionEntry(sessionId, now - 8 * DAY_MS),
  );
  expect(loadSessionEntry({ sessionKey: ordinaryKey, storePath })).toEqual(ordinaryEntry);
  await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toHaveLength(1);
  expect(await listDeletedArchiveFiles(path.dirname(storePath))).toStrictEqual([]);
});

it("applies pruning to stale cron-run descendant rows", async () => {
  const now = Date.now();
  const cases = [
    ["cron:done-job:run:old-run", "done-run", 8, false],
    ["cron:done-job:run:old-run:subagent:worker", "done-run-child", 8, false],
    ["cron:running-job:run:old-run", "running-run", 8, true],
    ["cron:running-job:run:old-run:thread:reply", "running-run-child", 8, true],
    ["subagent:ordinary-worker", "ordinary-worker", 40, true],
    ["cron:done-job:run:recent-run", "recent-run", 0, true],
  ] as const;
  const entries = Object.fromEntries(
    cases.map(([key, id, age]) => [`agent:main:${key}`, sessionEntry(id, now - age * DAY_MS)]),
  );
  const storePath = await createStore(entries);
  expect(await maintain(storePath, { runningCronJobIds: new Set(["running-job"]) })).toMatchObject({
    preservedRunning: 2,
    pruned: 2,
  });
  for (const [key, id, age, kept] of cases) {
    const sessionKey = `agent:main:${key}`;
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(
      kept ? sessionEntry(id, now - age * DAY_MS) : undefined,
    );
  }
});

it("preserves active cron rows until their admission releases", async () => {
  const { scope, read } = await cronCase("active-run");
  const admission = await beginSessionWorkAdmission({
    scope: scope.storePath,
    identities: [scope.sessionId],
    assertAllowed: () => {},
  });

  try {
    const before = Date.now();
    const activeResult = await maintain(scope.storePath);
    expect(activeResult.pruned).toBe(0);
    expect(activeResult.nextSweepAtMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(read()).toBeDefined();
  } finally {
    admission.release();
  }

  expect((await maintain(scope.storePath)).pruned).toBe(1);
  expect(read()).toBeUndefined();
});
