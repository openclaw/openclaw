import nodeFs from "node:fs";
import type { PathLike, StatOptions } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

async function expectPathExists(targetPath: string): Promise<void> {
  await fs.access(targetPath);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function expectBudgetResult(
  result: Awaited<ReturnType<typeof enforceSessionDiskBudget>>,
): asserts result is NonNullable<Awaited<ReturnType<typeof enforceSessionDiskBudget>>> {
  if (result === null) {
    throw new Error("expected disk budget enforcement result");
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
  it("excludes migration archives from physical SQLite usage (#106875)", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-sqlite-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
      if (!databasePath) {
        throw new Error("expected a SQLite database path");
      }
      await fs.writeFile(databasePath, Buffer.alloc(100));
      // Rollback archives are recovery artifacts outside the session budget;
      // counting them would evict live history to pay for unreclaimable bytes.
      await fs.writeFile(path.join(dir, "legacy.jsonl.migrated"), Buffer.alloc(4096));
      await fs.writeFile(path.join(dir, "legacy.jsonl.migrated.2"), Buffer.alloc(4096));
      for (const kind of ["branch", "openai-codex"]) {
        await fs.writeFile(
          path.join(dir, `legacy.jsonl.pre-doctor-${kind}-repair-2026-08-30T10-20-30-000Z.bak`),
          Buffer.alloc(4096),
        );
      }

      const usage = await measureSessionPhysicalDiskUsage(storePath);

      expect(usage.totalBytes).toBe(100);
      expect(usage.sessionFilesBytes).toBe(0);
    });
  });

  it("counts durable fixed-store agent partitions and their WAL files", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-partition-" }, async (dir) => {
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

      expect(usage.databaseMainBytes).toBe(partitionBytes);
      expect(usage.databaseWalBytes).toBe(77);
      expect(usage.sessionFilesBytes).toBe(0);
      expect(usage.totalBytes).toBe(partitionBytes + 77);
    });
  });

  it("removes true archived transcript artifacts while preserving referenced primary transcripts", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep.deleted.keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const archivePath = path.join(
        dir,
        `old-session.jsonl.deleted.${formatSessionArchiveTimestamp(Date.now() - 24 * 60 * 60 * 1000)}`,
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(archivePath, "a".repeat(260), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 300,
          highWaterBytes: 220,
        },
        warnOnly: false,
      });

      await expectPathExists(transcriptPath);
      await expectPathMissing(archivePath);
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
      expect(result.removedEntries).toBe(0);
    });
  });

  it("reclaims stale store temps under pressure but never a fresh in-flight one (#56827)", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const staleTemp = path.join(
        dir,
        "sessions.json.111.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp",
      );
      const freshTemp = path.join(
        dir,
        "sessions.json.222.1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d.tmp",
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": { sessionId, updatedAt: Date.now() },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(staleTemp, "s".repeat(300), "utf-8");
      await fs.writeFile(freshTemp, "f".repeat(300), "utf-8");
      // Age the stale temp past the staleness window; the fresh one is in-flight.
      const old = new Date(Date.now() - 30 * 60 * 1000);
      await fs.utimes(staleTemp, old, old);

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 750,
          highWaterBytes: 600,
        },
        warnOnly: false,
      });

      // Stale orphan reclaimed; fresh in-flight temp (a live atomic-write source)
      // and referenced transcript preserved even though still over the high-water mark.
      await expectPathMissing(staleTemp);
      await expectPathExists(freshTemp);
      await expectPathExists(transcriptPath);
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
    });
  });

  it("does not evict sessions for runtime-only resolved skill catalogs", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-runtime-skills-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:subagent:runtime-skills";
      const resolvedSkills = [
        createFixtureSkillEntry("demo", { source: "x".repeat(20_000) }).skill,
      ];
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

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: { maxDiskBytes: 2_048, highWaterBytes: 1_024 },
        warnOnly: false,
      });

      expect(result).toMatchObject({ overBudget: false, removedEntries: 0 });
      expect(store[sessionKey]).toBe(entry);
      expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
    });
  });

  it("accounts for deduped skills prompt blobs before evicting sessions", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const prompt = `<available_skills>\n${"shared prompt\n".repeat(200)}</available_skills>`;
      const now = Date.now();
      const store: Record<string, SessionEntry> = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `agent:main:${index}`,
          {
            sessionId: `session-${index}`,
            updatedAt: now + index,
            skillsSnapshot: {
              prompt,
              skills: [{ name: "demo" }],
              version: 1,
            },
          } satisfies SessionEntry,
        ]),
      );
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

      const inlineBytes = Buffer.byteLength(JSON.stringify(store, null, 2), "utf8");
      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: Math.floor(inlineBytes / 2),
          highWaterBytes: Math.floor(inlineBytes / 3),
        },
        warnOnly: false,
      });

      expectBudgetResult(result);
      expect(result.overBudget).toBe(false);
      expect(result.removedEntries).toBe(0);
      expect(Object.keys(store)).toHaveLength(12);
    });
  });

  it("removes unreferenced skills prompt blobs when evicting sessions", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const activeKey = "agent:main:active";
      const oldKey = "agent:main:old";
      const oldPrompt = `<available_skills>\n${"old prompt\n".repeat(200)}</available_skills>`;
      const activePrompt = `<available_skills>\n${"active prompt\n".repeat(200)}</available_skills>`;
      const store: Record<string, SessionEntry> = {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          archivedAt: 1,
          archiveReason: "active-session-cap",
          skillsSnapshot: {
            prompt: oldPrompt,
            skills: [{ name: "old" }],
            version: 1,
          },
        },
        [activeKey]: {
          sessionId: "active",
          updatedAt: 2,
          skillsSnapshot: {
            prompt: activePrompt,
            skills: [{ name: "active" }],
            version: 1,
          },
        },
      };
      await saveSessionStore(storePath, store, { skipMaintenance: true });
      const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, SessionEntry>;
      const oldHash = raw[oldKey]?.skillsSnapshot?.promptRef?.hash;
      const activeHash = raw[activeKey]?.skillsSnapshot?.promptRef?.hash;
      if (!oldHash || !activeHash) {
        throw new Error("expected prompt refs");
      }
      const oldBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        oldHash.slice(0, 2),
        `${oldHash}.txt`,
      );
      const activeBlob = path.join(
        dir,
        "skills-prompts",
        "sha256",
        activeHash.slice(0, 2),
        `${activeHash}.txt`,
      );
      await expectPathExists(oldBlob);
      await expectPathExists(activeBlob);
      const staleBlobTime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(oldBlob, staleBlobTime, staleBlobTime);

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 1,
          highWaterBytes: 1,
        },
        warnOnly: false,
        commitEvictedIndex: async () => {
          await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
        },
      });

      expectBudgetResult(result);
      expect(store).not.toHaveProperty(oldKey);
      expect(store).toHaveProperty(activeKey);
      await expectPathMissing(oldBlob);
      await expectPathExists(activeBlob);
    });
  });

  it("revalidates stale prompt blobs before removing them under pressure", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-revalidate-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:active": { sessionId: "active", updatedAt: Date.now() },
      };
      const hash = "d".repeat(64);
      const blobDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const blobPath = path.join(blobDir, `${hash}.txt`);
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.mkdir(blobDir, { recursive: true });
      await fs.writeFile(blobPath, "stale prompt blob".repeat(200), "utf-8");
      const staleBlobTime = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(blobPath, staleBlobTime, staleBlobTime);
      const statSpy = refreshPathBeforeSecondStat(blobPath);
      try {
        const result = await enforceSessionDiskBudget({
          store,
          storePath,
          maintenance: {
            maxDiskBytes: 1,
            highWaterBytes: 1,
          },
          warnOnly: false,
        });

        expectBudgetResult(result);
        expect(result.overBudget).toBe(true);
        expect(result.removedFiles).toBe(0);
        await expectPathExists(blobPath);
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  it("reclaims stale skills prompt blob temps under pressure", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-prompt-temp-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:main": { sessionId: "keep", updatedAt: Date.now() },
      };
      const hash = "a".repeat(64);
      const tempDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const tempPath = path.join(
        tempDir,
        `${hash}.txt.123.11111111-1111-4111-8111-111111111111.tmp`,
      );
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(tempPath, "t".repeat(2000), "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      await fs.utimes(tempPath, old, old);

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 1000,
          highWaterBytes: 500,
        },
        warnOnly: false,
      });

      await expectPathMissing(tempPath);
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
      expect(result.removedEntries).toBe(0);
    });
  });

  it("removes unreferenced compaction checkpoint artifacts under pressure", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const checkpointPath = path.join(
        dir,
        "keep.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      );
      const referencedCheckpointPath = path.join(
        dir,
        "..keep.checkpoint.22222222-2222-4222-8222-222222222222.jsonl",
      );
      const referencedPostCompactionPath = path.join(dir, "keep-compacted.jsonl");
      // Historical metadata is deliberately outside the current session model.
      const store = {
        "agent:main:main": {
          sessionId,
          updatedAt: Date.now(),
          compactionCheckpoints: [
            {
              checkpointId: "referenced",
              sessionKey: "agent:main:main",
              sessionId,
              createdAt: Date.now(),
              reason: "manual",
              preCompaction: {
                sessionId,
                sessionFile: referencedCheckpointPath,
                leafId: "leaf",
              },
              postCompaction: { sessionId, sessionFile: referencedPostCompactionPath },
            },
          ],
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
      await fs.writeFile(checkpointPath, "c".repeat(5000), "utf-8");
      await fs.writeFile(referencedCheckpointPath, "r".repeat(260), "utf-8");
      await fs.utimes(referencedCheckpointPath, new Date(0), new Date(0));
      await fs.writeFile(referencedPostCompactionPath, "p".repeat(260), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 4000,
          highWaterBytes: 3000,
        },
        warnOnly: false,
      });

      await expectPathExists(transcriptPath);
      await expectPathMissing(checkpointPath);
      await expectPathExists(referencedCheckpointPath);
      await expectPathExists(referencedPostCompactionPath);
      expectBudgetResult(result);
      expect(result.removedFiles).toBe(1);
      expect(result.removedEntries).toBe(0);
    });
  });

  it.each([["keep.log", "keep.log.trajectory.jsonl", "keep.log.trajectory-path.json"]])(
    "removes orphaned sidecars while preserving %s companions",
    async (transcript, runtime, pointer) => {
      await withTestDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        const sessionId = "keep";
        const transcriptPath = path.join(dir, transcript);
        const referencedRuntime = path.join(dir, runtime);
        const referencedPointer = path.join(dir, pointer);
        const orphanRuntime = path.join(dir, "old.trajectory.jsonl");
        const orphanPointer = path.join(dir, "old.trajectory-path.json");
        const store: Record<string, SessionEntry> = {
          "agent:main:main": Object.assign(
            {
              sessionId,
              updatedAt: Date.now(),
            },
            { sessionFile: transcriptPath },
          ),
        };
        await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
        await fs.writeFile(transcriptPath, "k".repeat(80), "utf-8");
        await fs.writeFile(referencedRuntime, "r".repeat(80), "utf-8");
        await fs.writeFile(referencedPointer, "p".repeat(80), "utf-8");
        await fs.writeFile(orphanRuntime, "o".repeat(5000), "utf-8");
        await fs.writeFile(orphanPointer, "q".repeat(5000), "utf-8");

        const result = await enforceSessionDiskBudget({
          store,
          storePath,
          maintenance: {
            maxDiskBytes: 7000,
            highWaterBytes: 2000,
          },
          warnOnly: false,
        });

        await expectPathExists(transcriptPath);
        await expectPathExists(referencedRuntime);
        await expectPathExists(referencedPointer);
        await expectPathMissing(orphanRuntime);
        await expectPathMissing(orphanPointer);
        expectBudgetResult(result);
        expect(result.removedFiles).toBe(2);
        expect(result.removedEntries).toBe(0);
      });
    },
  );

  it("retains the evicted transcript when the index commit fails", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-commit-fail-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const oldKey = "agent:main:subagent:old-worker";
      const activeKey = "agent:main:main";
      const oldTranscript = path.join(dir, "old.jsonl");
      const store: Record<string, SessionEntry> = {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          archivedAt: 1,
          archiveReason: "active-session-cap",
        },
        [activeKey]: { sessionId: "active", updatedAt: 2 },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(oldTranscript, "t".repeat(10 * 1024), "utf-8");

      const commitFailure = new Error("simulated store-write failure");
      await expect(
        enforceSessionDiskBudget({
          store,
          storePath,
          maintenance: { maxDiskBytes: 100, highWaterBytes: 100 },
          warnOnly: false,
          commitEvictedIndex: async () => {
            throw commitFailure;
          },
        }),
      ).rejects.toBe(commitFailure);

      await expectPathExists(oldTranscript);
    });
  });

  it("retains evicted artifacts when no durable index commit is available", async () => {
    await withTestDir({ prefix: "openclaw-disk-budget-missing-commit-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const oldKey = "agent:main:subagent:old-worker";
      const activeKey = "agent:main:main";
      const oldTranscript = path.join(dir, "old.jsonl");
      const store: Record<string, SessionEntry> = {
        [oldKey]: {
          sessionId: "old",
          updatedAt: 1,
          archivedAt: 1,
          archiveReason: "active-session-cap",
        },
        [activeKey]: { sessionId: "active", updatedAt: 2 },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      await fs.writeFile(oldTranscript, "t".repeat(10 * 1024), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: { maxDiskBytes: 100, highWaterBytes: 100 },
        warnOnly: false,
      });

      expectBudgetResult(result);
      expect(result.removedEntries).toBe(1);
      expect(result.removedFiles).toBe(0);
      expect(result.totalBytesAfter).toBeGreaterThan(result.highWaterBytes);
      expect(store[oldKey]).toBeUndefined();
      await expectPathExists(oldTranscript);
    });
  });

  it("stops at the default target when highWaterBytes resolves to zero", async () => {
    await withTestDir({ prefix: "openclaw-zero-high-water-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const store: Record<string, SessionEntry> = {};
      for (let index = 1; index <= 4; index += 1) {
        await fs.writeFile(path.join(dir, `worker-${index}.jsonl`), "x".repeat(64 * 1024));
        store[`agent:main:subagent:worker-${index}`] = {
          sessionId: `worker-${index}`,
          updatedAt: index,
          archivedAt: index,
          archiveReason: "active-session-cap",
        };
      }
      await saveSessionStore(storePath, store, { skipMaintenance: true });

      const maintenance = resolveMaintenanceConfigFromInput({
        maxDiskBytes: 200_000,
        highWaterBytes: 0,
      });
      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: maintenance.maxDiskBytes,
          highWaterBytes: maintenance.highWaterBytes,
        },
        warnOnly: false,
        commitEvictedIndex: async () => {
          await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
        },
      });

      // The resolved high-water mark is this loop's stop condition, so a zero
      // mark is unreachable while any data remains and every session would be
      // evicted. The default target stops the sweep with history intact.
      expect(maintenance.highWaterBytes).toBe(160_000);
      expectBudgetResult(result);
      expect(result.totalBytesAfter).toBeLessThanOrEqual(160_000);
      expect(store).toHaveProperty("agent:main:subagent:worker-4");
      await expectPathExists(path.join(dir, "worker-4.jsonl"));
    });
  });
});

describe("pruneUnreferencedSessionArtifacts", () => {
  it("prunes only stale unreferenced artifacts through the canonical SQLite selector", async () => {
    await withTestDir({ prefix: "openclaw-prune-selector-" }, async (dir) => {
      const agentDir = path.join(dir, "agents", "main");
      const sessionsDir = path.join(agentDir, "sessions");
      const databasePath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
      const hash = "a".repeat(64);
      const blobDir = path.join(sessionsDir, "skills-prompts", "sha256", "aa");
      await fs.mkdir(blobDir, { recursive: true });
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(databasePath, "database fixture");
      const retainedPath = path.join(sessionsDir, "keep.jsonl");
      const orphanPath = path.join(sessionsDir, "orphan.jsonl");
      const freshPath = path.join(sessionsDir, "fresh.jsonl");
      const blobPath = path.join(blobDir, `${hash}.txt`);
      for (const filePath of [retainedPath, orphanPath, freshPath, blobPath]) {
        await fs.writeFile(filePath, "fixture");
      }
      const old = new Date(Date.now() - 30 * 60_000);
      for (const filePath of [retainedPath, orphanPath, blobPath]) {
        await fs.utimes(filePath, old, old);
      }
      const storePath = databasePath;
      const result = await pruneUnreferencedSessionArtifacts({
        store: { "agent:main:main": { sessionId: "keep", updatedAt: Date.now() } },
        storePath,
        olderThanMs: 60_000,
      });

      expect(result.removedFiles).toBe(2);
      await expectPathMissing(orphanPath);
      await expectPathMissing(blobPath);
      await expectPathExists(retainedPath);
      await expectPathExists(freshPath);
      await expectPathExists(databasePath);
    });
  });

  it("preserves fresh unreferenced skills prompt blobs during normal artifact cleanup", async () => {
    await withTestDir({ prefix: "openclaw-prune-fresh-prompt-blob-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const hash = "c".repeat(64);
      const blobDir = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2));
      const blobPath = path.join(blobDir, `${hash}.txt`);
      await fs.writeFile(storePath, JSON.stringify({}, null, 2), "utf-8");
      await fs.mkdir(blobDir, { recursive: true });
      await fs.writeFile(blobPath, "fresh unreferenced prompt blob".repeat(200), "utf-8");

      const result = await pruneUnreferencedSessionArtifacts({
        store: {},
        storePath,
        olderThanMs: 0,
      });

      await expectPathExists(blobPath);
      expect(result.removedFiles).toBe(0);
    });
  });
});

const EMPTY_PROMPT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PROMPT_FILE = `skills-prompts/sha256/e3/${EMPTY_PROMPT_HASH}.txt`;
const TEMP_SUFFIX = ".123.0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp";
const ARCHIVE_STAMP = "2026-01-01T00-00-00.000Z";
const PRESSURE = { maxDiskBytes: 64, highWaterBytes: 64 };

async function writeOldFile(dir: string, name: string, content = ""): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  const old = new Date(Date.now() - 60 * 60_000);
  await fs.utimes(filePath, old, old);
  return filePath;
}

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

it("counts shared empty evicted artifacts once", async () => {
  await withTestDir({ prefix: "openclaw-zero-byte-evicted-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const artifacts = await Promise.all(
      ["old.jsonl", "old.trajectory.jsonl", "old.trajectory-path.json", PROMPT_FILE].map((name) =>
        writeOldFile(dir, name),
      ),
    );
    const store: Record<string, SessionEntry> = {};
    for (const sessionId of ["old", "alias"]) {
      store[`agent:main:subagent:${sessionId}`] = {
        sessionId,
        sessionFile: path.join(dir, "old.jsonl"),
        updatedAt: 1,
        archivedAt: 1,
        archiveReason: "active-session-cap",
        skillsSnapshot: {
          prompt: "",
          skills: [],
          promptRef: { version: 1, algorithm: "sha256", hash: EMPTY_PROMPT_HASH, bytes: 0 },
        },
      };
    }
    await fs.writeFile(storePath, JSON.stringify(store, null, 2));
    await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));

    const result = await enforceSessionDiskBudget({
      store,
      storePath,
      maintenance: PRESSURE,
      warnOnly: false,
      commitEvictedIndex: async () => {
        await fs.writeFile(storePath, JSON.stringify(store, null, 2));
      },
    });

    expect(result).toMatchObject({
      removedEntries: 2,
      removedFiles: artifacts.length,
      freedBytes: 0,
      totalBytesAfter: 130,
    });
    expect(store).toEqual({});
    expect(artifacts.map((artifact) => nodeFs.existsSync(artifact))).toEqual(
      artifacts.map(() => false),
    );
  });
});

it("counts empty retained archives under pressure and returns real disk usage", async () => {
  await withTestDir({ prefix: "openclaw-zero-byte-archives-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
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
});

it("does not count an empty file removed by another cleanup before rm", async () => {
  await withTestDir({ prefix: "openclaw-missing-removal-" }, async (dir) => {
    const artifact = await writeOldFile(dir, "orphan.jsonl");
    await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
    const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
    const rm = vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
      if (target === artifact) {
        await originalRm(target);
      }
      return originalRm(target, options);
    });
    try {
      const result = await enforceSessionDiskBudget({
        store: {},
        storePath: path.join(dir, "sessions.json"),
        maintenance: PRESSURE,
        warnOnly: false,
      });

      expect(result).toMatchObject({ removedFiles: 0, freedBytes: 0 });
      await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rm.mockRestore();
    }
  });
});

it.each(["unreferenced", "archives"] as const)(
  "%s cleanup does not count a rejected nonempty removal",
  async (cleanup) => {
    await withTestDir({ prefix: "openclaw-rejected-removal-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const name = cleanup === "archives" ? `old.jsonl.deleted.${ARCHIVE_STAMP}` : "orphan.jsonl";
      const content = "x".repeat(64);
      const artifact = await writeOldFile(dir, name, content);
      await fs.writeFile(path.join(dir, "filler.bin"), Buffer.alloc(128));
      const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
      const rm = vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
        if (target === artifact) {
          throw new Error("injected removal failure");
        }
        return originalRm(target, options);
      });
      try {
        if (cleanup === "archives") {
          const result = await pruneSessionTranscriptArchivesToHighWater({
            storePath,
            highWaterBytes: 64,
          });
          expect(result.removedFiles).toBe(0);
          expect(result.usage.totalBytes).toBe(192);
        } else {
          const result = await pruneUnreferencedSessionArtifacts({
            store: {},
            storePath,
            olderThanMs: 1000,
          });
          expect(result).toMatchObject({ removedFiles: 0, freedBytes: 0 });
        }
        expect(await fs.readFile(artifact, "utf8")).toBe(content);
      } finally {
        rm.mockRestore();
      }
    });
  },
);
