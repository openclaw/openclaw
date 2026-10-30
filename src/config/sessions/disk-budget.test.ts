import nodeFs from "node:fs";
import type { PathLike, StatOptions } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it as baseIt, vi } from "vitest";
import { saveLegacySessionStore as saveSessionStore } from "../../infra/state-migrations.legacy-session-store.js";
import { createFixtureSkillEntry } from "../../skills/test-support/test-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { removeFileIfExists } from "./disk-budget-files.js";
import {
  enforceSessionDiskBudget,
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
  pruneUnreferencedSessionArtifacts,
} from "./disk-budget.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type BudgetOptions = Omit<
  Parameters<typeof enforceSessionDiskBudget>[0],
  "store" | "storePath" | "maintenance" | "warnOnly"
>;
function enforceBudget(
  storePath: string,
  store: Record<string, SessionEntry>,
  maxDiskBytes: number | null,
  highWaterBytes: number | null,
  options: BudgetOptions = {},
) {
  return enforceSessionDiskBudget({
    storePath,
    store,
    maintenance: { maxDiskBytes, highWaterBytes },
    warnOnly: false,
    ...options,
  });
}
const archivedEntry = (sessionId: string, updatedAt: number): SessionEntry => ({
  sessionId,
  updatedAt,
  archivedAt: updatedAt,
  archiveReason: "active-session-cap",
});

const makeEntry = (sessionId: string, updatedAt = Date.now()): SessionEntry => ({
  sessionId,
  updatedAt,
});
const skillsSnapshot = (name: string, prompt = `${name} prompt\n`.repeat(200)) => ({
  prompt,
  skills: [{ name }],
  version: 1,
});
const promptBlob = (dir: string, hash: string) =>
  path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2), `${hash}.txt`);
const writeStore = (storePath: string, store: Record<string, SessionEntry>) =>
  fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
const commitStore = (storePath: string, store: Record<string, SessionEntry>) => ({
  commitEvictedIndex: () => writeStore(storePath, store),
});
type DiskFixture = { dir: string; storePath: string };
const it = baseIt.extend<DiskFixture>({
  dir: async ({ task: _task }, use) => withTestDir({ prefix: "openclaw-disk-budget-" }, use),
  storePath: async ({ dir }, use) => use(path.join(dir, "sessions.json")),
});
async function ageFile(filePath: string, ageMs = 30 * 60_000) {
  const old = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, old, old);
}
async function writeArtifact(filePath: string, content: string, stale = false) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  if (stale) {
    await ageFile(filePath);
  }
  return filePath;
}
async function writeArtifacts(dir: string, files: Record<string, number>) {
  for (const [name, bytes] of Object.entries(files)) {
    await writeArtifact(path.join(dir, name), "x".repeat(bytes));
  }
}
const activeStore = (sessionId = "keep", extra: Partial<SessionEntry> = {}) => ({
  "agent:main:main": { ...makeEntry(sessionId), ...extra },
});
async function evictionFixture(dir: string) {
  const storePath = path.join(dir, "sessions.json");
  const oldKey = "agent:main:subagent:old-worker";
  const store: Record<string, SessionEntry> = {
    [oldKey]: archivedEntry("old", 1),
    "agent:main:main": makeEntry("active", 2),
  };
  await writeStore(storePath, store);
  const oldTranscript = await writeArtifact(path.join(dir, "old.jsonl"), "t".repeat(10 * 1024));
  return { storePath, oldKey, store, oldTranscript };
}
async function expectPathExists(...targetPaths: string[]): Promise<void> {
  await Promise.all(targetPaths.map((targetPath) => fs.access(targetPath)));
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function verifyCleanup(
  { dir, storePath }: DiskFixture,
  keep: Record<string, number>,
  remove: Record<string, number>,
  max: number,
  high: number,
  store: Record<string, SessionEntry> = activeStore(),
  stale: string[] = [],
) {
  await writeStore(storePath, store);
  await writeArtifacts(dir, { ...keep, ...remove });
  for (const name of stale) {
    await ageFile(path.join(dir, name));
  }
  await enforceBudget(storePath, store, max, high);
  await expectPathExists(...Object.keys(keep).map((name) => path.join(dir, name)));
  for (const name of Object.keys(remove)) {
    await expectPathMissing(path.join(dir, name));
  }
}

function refreshPathBeforeSecondStat(targetPath: string): ReturnType<typeof vi.spyOn> {
  const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
  let statCalls = 0;
  return vi
    .spyOn(nodeFs.promises, "stat")
    .mockImplementation(async (target: PathLike, options?: StatOptions) => {
      if (target === targetPath) {
        statCalls += 1;
        if (statCalls === 2) {
          const now = new Date();
          await fs.utimes(targetPath, now, now);
        }
      }
      return await originalStat(target, options);
    });
}

describe("enforceSessionDiskBudget", () => {
  it("excludes migration archives from usage (#106875)", async ({ dir, storePath }) => {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
    // Rollback archives are recovery artifacts outside the session budget;
    // counting them would evict live history to pay for unreclaimable bytes.
    await writeArtifacts(dir, {
      [path.basename(databasePath)]: 100,
      "legacy.jsonl.migrated": 4096,
      "legacy.jsonl.migrated.2": 4096,
      "legacy.jsonl.pre-doctor-branch-repair-2026-08-30T10-20-30-000Z.bak": 4096,
      "legacy.jsonl.pre-doctor-openai-codex-repair-2026-08-30T10-20-30-000Z.bak": 4096,
    });
    expect(await measureSessionPhysicalDiskUsage(storePath)).toMatchObject({ totalBytes: 100 });
  });

  it("counts durable fixed-store agent partitions and their WAL files", async ({ dir }) => {
    const stateDir = path.join(dir, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storePath = path.join(dir, "shared.json");
    const partitionPath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "ops",
      defaultAgentId: "main",
      env,
    }).path;
    const database = openOpenClawAgentDatabase({ agentId: "ops", env, path: partitionPath });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.writeFile(`${partitionPath}-wal`, Buffer.alloc(77));
    const partitionBytes = (await fs.stat(database.path)).size;

    const usage = await measureSessionPhysicalDiskUsage(storePath);

    expect(usage).toMatchObject({
      databaseWalBytes: 77,
      totalBytes: partitionBytes + 77,
    });
  });

  it("removes archives, not referenced primary transcripts", async ({ dir, storePath }) => {
    const archive = `old-session.jsonl.deleted.${formatSessionArchiveTimestamp(Date.now() - 86_400_000)}`;
    await verifyCleanup(
      { dir, storePath },
      { "keep.deleted.keep.jsonl": 80 },
      { [archive]: 260 },
      300,
      220,
      activeStore("keep.deleted.keep"),
    );
  });

  it("reclaims stale store temps, not in-flight ones (#56827)", async ({ dir, storePath }) => {
    const stale = "sessions.json.111.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp";
    const fresh = "sessions.json.222.1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d.tmp";
    await verifyCleanup(
      { dir, storePath },
      { "keep.jsonl": 80, [fresh]: 300 },
      { [stale]: 300 },
      750,
      600,
      activeStore(),
      [stale],
    );
  });

  it("excludes runtime-only skills from budget", async ({ storePath }) => {
    const sessionKey = "agent:main:subagent:runtime-skills";
    const resolvedSkills = [createFixtureSkillEntry("demo", { source: "x".repeat(20_000) }).skill];
    const entry: SessionEntry = {
      sessionId: "runtime-skills",
      updatedAt: Date.now(),
      skillsSnapshot: {
        prompt: "compact prompt",
        skills: [{ name: "demo" }],
        resolvedSkills,
      },
    };
    const store = { [sessionKey]: entry };

    const log = { warn: vi.fn(), info: vi.fn() };
    await enforceBudget(storePath, store, 2_048, 1_024, { log });

    expect(log.warn).not.toHaveBeenCalled();
    expect(store[sessionKey]).toBe(entry);
    expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
  });

  it("deduplicates projected prompt blob bytes", async ({ storePath }) => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `agent:main:${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: now + index,
          skillsSnapshot: skillsSnapshot("demo"),
        } satisfies SessionEntry,
      ]),
    );
    await writeStore(storePath, store);

    const inlineBytes = Buffer.byteLength(JSON.stringify(store, null, 2), "utf8");
    const log = { warn: vi.fn(), info: vi.fn() };
    await enforceBudget(
      storePath,
      store,
      Math.floor(inlineBytes / 2),
      Math.floor(inlineBytes / 3),
      { log },
    );

    expect(log.warn).not.toHaveBeenCalled();
    expect(Object.keys(store)).toHaveLength(12);
  });

  it("reclaims evicted sessions' prompt blobs", async ({ dir, storePath }) => {
    const activeKey = "agent:main:active";
    const oldKey = "agent:main:old";
    const store: Record<string, SessionEntry> = {
      [oldKey]: {
        ...archivedEntry("old", 1),
        skillsSnapshot: skillsSnapshot("old"),
      },
      [activeKey]: {
        ...makeEntry("active", 2),
        skillsSnapshot: skillsSnapshot("active"),
      },
    };
    await saveSessionStore(storePath, store, { skipMaintenance: true });
    const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, SessionEntry>;
    const oldHash = raw[oldKey]?.skillsSnapshot?.promptRef?.hash;
    const activeHash = raw[activeKey]?.skillsSnapshot?.promptRef?.hash;
    if (!oldHash || !activeHash) {
      throw new Error("expected prompt refs");
    }
    const oldBlob = promptBlob(dir, oldHash);
    const activeBlob = promptBlob(dir, activeHash);
    await expectPathExists(oldBlob, activeBlob);
    await ageFile(oldBlob, 10 * 60_000);

    await enforceBudget(storePath, store, 1, 1, commitStore(storePath, store));

    expect(store).not.toHaveProperty(oldKey);
    expect(store).toHaveProperty(activeKey);
    await expectPathMissing(oldBlob);
    await expectPathExists(activeBlob);
  });

  it("revalidates prompt blob age before removal", async ({ dir, storePath }) => {
    const store = { "agent:main:active": makeEntry("active") };
    const hash = "d".repeat(64);
    const blobPath = promptBlob(dir, hash);
    await writeStore(storePath, store);
    await writeArtifact(blobPath, "stale prompt blob".repeat(200), true);
    const statSpy = refreshPathBeforeSecondStat(blobPath);
    try {
      await enforceBudget(storePath, store, 1, 1);

      await expectPathExists(blobPath);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("reclaims stale skills prompt blob temps under pressure", async ({ dir, storePath }) => {
    const temp = `skills-prompts/sha256/aa/${"a".repeat(64)}.txt.123.11111111-1111-4111-8111-111111111111.tmp`;
    await verifyCleanup({ dir, storePath }, {}, { [temp]: 2000 }, 1000, 500, activeStore(), [temp]);
  });

  it("preserves referenced legacy checkpoints", async ({ dir, storePath }) => {
    const sessionId = "keep";
    const checkpoint = "keep.checkpoint.11111111-1111-4111-8111-111111111111.jsonl";
    const referenced = "..keep.checkpoint.22222222-2222-4222-8222-222222222222.jsonl";
    // Historical metadata is deliberately outside the current session model.
    const store = {
      "agent:main:main": {
        sessionId,
        updatedAt: Date.now(),
        compactionCheckpoints: [
          {
            preCompaction: { sessionFile: path.join(dir, referenced) },
            postCompaction: { sessionFile: path.join(dir, "keep-compacted.jsonl") },
          },
        ],
      },
    };
    await verifyCleanup(
      { dir, storePath },
      { "keep.jsonl": 80, [referenced]: 260, "keep-compacted.jsonl": 260 },
      { [checkpoint]: 5000 },
      4000,
      3000,
      store,
      [referenced],
    );
  });

  it("preserves custom transcript sidecars, not orphans", async ({ dir, storePath }) => {
    await verifyCleanup(
      { dir, storePath },
      { "keep.log": 80, "keep.log.trajectory.jsonl": 80, "keep.log.trajectory-path.json": 80 },
      { "old.trajectory.jsonl": 5000, "old.trajectory-path.json": 5000 },
      7000,
      2000,
      activeStore("keep", { sessionFile: path.join(dir, "keep.log") }),
    );
  });

  it("retains the evicted transcript when the index commit fails", async ({ dir }) => {
    const { storePath, store, oldTranscript } = await evictionFixture(dir);

    const commitFailure = new Error("simulated store-write failure");
    await expect(
      enforceBudget(storePath, store, 100, 100, {
        commitEvictedIndex: async () => {
          throw commitFailure;
        },
      }),
    ).rejects.toBe(commitFailure);

    await expectPathExists(oldTranscript);
  });

  it("retains evicted artifacts when no durable index commit is available", async ({ dir }) => {
    const { storePath, oldKey, store, oldTranscript } = await evictionFixture(dir);

    await enforceBudget(storePath, store, 100, 100);

    expect((await measureSessionPhysicalDiskUsage(storePath)).totalBytes).toBeGreaterThan(100);
    expect(store[oldKey]).toBeUndefined();
    await expectPathExists(oldTranscript);
  });

  it("defaults a zero high-water mark before eviction", async ({ dir, storePath }) => {
    const store: Record<string, SessionEntry> = {};
    for (let index = 1; index <= 4; index += 1) {
      await fs.writeFile(path.join(dir, `worker-${index}.jsonl`), "x".repeat(64 * 1024));
      store[`agent:main:subagent:worker-${index}`] = archivedEntry(`worker-${index}`, index);
    }
    await saveSessionStore(storePath, store, { skipMaintenance: true });

    const maintenance = resolveMaintenanceConfigFromInput({
      maxDiskBytes: 200_000,
      highWaterBytes: 0,
    });
    await enforceBudget(
      storePath,
      store,
      maintenance.maxDiskBytes,
      maintenance.highWaterBytes,
      commitStore(storePath, store),
    );

    expect(maintenance.highWaterBytes).toBe(160_000);
    expect((await measureSessionPhysicalDiskUsage(storePath)).totalBytes).toBeLessThanOrEqual(
      160_000,
    );
    expect(store).toHaveProperty("agent:main:subagent:worker-4");
    await expectPathExists(path.join(dir, "worker-4.jsonl"));
  });
});

describe("pruneUnreferencedSessionArtifacts", () => {
  it("prunes SQLite-selector stale orphans, not live files", async ({ dir }) => {
    const agentDir = path.join(dir, "agents", "main");
    const sessionsDir = path.join(agentDir, "sessions");
    const databasePath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
    await writeArtifact(databasePath, "database fixture");
    const retainedPath = path.join(sessionsDir, "keep.jsonl");
    const orphanPath = path.join(sessionsDir, "orphan.jsonl");
    const freshPath = path.join(sessionsDir, "fresh.jsonl");
    const blobPath = promptBlob(sessionsDir, "a".repeat(64));
    for (const filePath of [retainedPath, orphanPath, freshPath, blobPath]) {
      await writeArtifact(filePath, "fixture", filePath !== freshPath);
    }
    const storePath = databasePath;
    const result = await pruneUnreferencedSessionArtifacts({
      store: { "agent:main:main": makeEntry("keep") },
      storePath,
      olderThanMs: 60_000,
    });

    expect(result.removedFiles).toBe(2);
    await expectPathMissing(orphanPath);
    await expectPathMissing(blobPath);
    await expectPathExists(retainedPath, freshPath, databasePath);
  });

  it("preserves fresh unreferenced prompt blobs", async ({ dir, storePath }) => {
    const blobPath = promptBlob(dir, "c".repeat(64));
    await writeStore(storePath, {});
    await writeArtifact(blobPath, "fresh unreferenced prompt blob");

    const result = await pruneUnreferencedSessionArtifacts({
      store: {},
      storePath,
      olderThanMs: 0,
    });

    await expectPathExists(blobPath);
    expect(result.removedFiles).toBe(0);
  });
});

const EMPTY_PROMPT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PROMPT_FILE = `skills-prompts/sha256/e3/${EMPTY_PROMPT_HASH}.txt`;
const TEMP_SUFFIX = ".123.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp";
const ARCHIVE_STAMP = "2026-01-01T00-00-00.000Z";
const writeOldFile = (dir: string, name: string, content = "") =>
  writeArtifact(path.join(dir, name), content, true);

it.each([
  { kind: "store temp", name: `sessions.json${TEMP_SUFFIX}`, dryRun: false },
  { kind: "transcript", name: "orphan.jsonl", dryRun: true },
])(
  "counts an empty $kind once without freeing bytes (dryRun=$dryRun)",
  async ({ name, dryRun }) => {
    await withTestDir({ prefix: "openclaw-zero-byte-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const artifact = await writeOldFile(dir, name);
      await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
      const run = () =>
        pruneUnreferencedSessionArtifacts({
          store: {},
          storePath,
          olderThanMs: 1000,
          dryRun,
        });
      const result = await run();
      expect(result).toMatchObject({ removedFiles: 1, freedBytes: 0 });
      expect(nodeFs.existsSync(artifact)).toBe(dryRun);
      if (!dryRun) {
        expect(await run()).toMatchObject({ removedFiles: 0, freedBytes: 0 });
      }
    });
  },
);

it("removes shared empty evicted artifacts", async ({ dir, storePath }) => {
  const artifacts = await Promise.all(
    ["old.jsonl", "old.trajectory.jsonl", "old.trajectory-path.json", PROMPT_FILE].map((name) =>
      writeOldFile(dir, name),
    ),
  );
  const store: Record<string, SessionEntry> = {};
  for (const sessionId of ["old", "alias"]) {
    store[`agent:main:subagent:${sessionId}`] = {
      ...archivedEntry(sessionId, 1),
      sessionFile: path.join(dir, "old.jsonl"),
      skillsSnapshot: {
        prompt: "",
        skills: [],
        promptRef: { version: 1, algorithm: "sha256", hash: EMPTY_PROMPT_HASH, bytes: 0 },
      },
    };
  }
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
  await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));

  await enforceBudget(storePath, store, 64, 64, commitStore(storePath, store));

  expect(store).toEqual({});
  expect(artifacts.map((artifact) => nodeFs.existsSync(artifact))).toEqual(
    artifacts.map(() => false),
  );
});

it("counts empty retained archives under pressure and returns real disk usage", async ({
  dir,
  storePath,
}) => {
  const archives = await Promise.all(
    ["deleted", "reset", "bak"].map((reason) =>
      writeOldFile(dir, `old.jsonl.${reason}.${ARCHIVE_STAMP}`),
    ),
  );
  const excludedName = `keep.jsonl.deleted.${ARCHIVE_STAMP}`;
  const excluded = await writeOldFile(dir, excludedName);
  await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
  const params: Parameters<typeof pruneSessionTranscriptArchivesToHighWater>[0] = {
    storePath,
    highWaterBytes: 64,
    removeFile: async (file) => {
      if (file.name === excludedName) {
        return "preserved";
      }
      return (await removeFileIfExists(file.path)).ok ? "removed" : "failed";
    },
  };

  const result = await pruneSessionTranscriptArchivesToHighWater(params);

  expect(result.removedFiles).toBe(3);
  expect(result.usage).toEqual(await measureSessionPhysicalDiskUsage(storePath));
  expect(result.usage.totalBytes).toBe(128);
  expect(archives.map((archive) => nodeFs.existsSync(archive))).toEqual([false, false, false]);
  expect(nodeFs.existsSync(excluded)).toBe(true);
  expect(await pruneSessionTranscriptArchivesToHighWater(params)).toEqual({
    removedFiles: 0,
    usage: result.usage,
  });
});

it("does not count an empty file removed by another cleanup before rm", async ({
  dir,
  storePath,
}) => {
  const artifact = await writeOldFile(dir, "orphan.jsonl");
  await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
  const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
  const log = { warn: vi.fn(), info: vi.fn() };
  const rm = vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
    if (target === artifact) {
      await originalRm(target);
    }
    return originalRm(target, options);
  });
  try {
    await enforceBudget(storePath, {}, 64, 64, { log });

    expect(log.warn).toHaveBeenCalledWith(
      "session disk budget still above high-water target after cleanup",
      expect.objectContaining({ removedFiles: 0, removedEntries: 0 }),
    );
    expect(log.info).not.toHaveBeenCalled();
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    rm.mockRestore();
  }
});
