import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../../infra/json-files.js";
import { saveLegacySessionStore } from "../../infra/state-migrations.legacy-session-store.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { removeFileIfExists } from "./disk-budget-files.js";
import {
  enforceSessionDiskBudget as enforceBudget,
  measureSessionPhysicalDiskUsage as measureUsage,
  pruneSessionTranscriptArchivesToHighWater as pruneArchives,
  pruneUnreferencedSessionArtifacts as pruneOrphans,
} from "./disk-budget.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { projectSessionStoreForPersistence } from "./skill-prompt-blobs.js";
import type { SessionEntry } from "./types.js";

const archivedEntry = (
  sessionId: string,
  updatedAt: number,
  extra: Partial<SessionEntry> = {},
): SessionEntry => ({
  sessionId,
  updatedAt,
  archivedAt: updatedAt,
  archiveReason: "active-session-cap",
  ...extra,
});
const oldKey = "agent:main:subagent:old";
const activeKey = "agent:main:active";
const preservedKey = "agent:main:preserved";
const laterKey = "agent:main:subagent:later";
const json = (store: Record<string, SessionEntry>) => JSON.stringify(store, null, 2);
async function writeArtifact(file: string, size: number, fill = 1, mtime = new Date(0)) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(size, fill));
  await fs.utimes(file, mtime, mtime);
}
async function expectArtifacts(files: { file: string; size: number }[]) {
  for (const { file, size } of files) {
    expect(await fs.readFile(file)).toEqual(Buffer.alloc(size, 1));
  }
}
const budget = (highWaterBytes: number) => ({ maxDiskBytes: highWaterBytes + 1, highWaterBytes });
const withStoreDir = (run: (dir: string, storePath: string) => Promise<void>) =>
  withTestDir({ prefix: "openclaw-removal-failure-" }, (dir) =>
    run(dir, path.join(dir, "sessions.json")),
  );
afterEach(() => vi.restoreAllMocks());
function rejectRemoval(
  targetPaths: string | string[],
  code: "EPERM" | "EACCES",
  inspect?: (target: nodeFs.PathLike) => Promise<void>,
) {
  const blocked = new Set(typeof targetPaths === "string" ? [targetPaths] : targetPaths);
  const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
  return vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
    await inspect?.(target);
    if (typeof target === "string" && blocked.has(target)) {
      throw Object.assign(new Error(`injected ${code}`), { code });
    }
    return await originalRm(target, options);
  });
}

it("retains an artifact when offline maintenance custody is revoked during inspection", async () => {
  await withOpenClawTestState({ label: "cleanup-revoked-owner" }, async (state) => {
    const file = await state.writeText("orphan.jsonl", "retained");
    let current = true;
    const scope = createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent: () => {
        if (!current) {
          throw new Error("maintenance owner revoked");
        }
      },
    });
    const stat = nodeFs.promises.stat.bind(nodeFs.promises);
    vi.spyOn(nodeFs.promises, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (args[0] === file) {
        current = false;
      }
      return result;
    });
    try {
      await expect(scope.run(() => removeFileIfExists(file))).rejects.toThrow(
        "maintenance owner revoked",
      );
      expect(await fs.readFile(file, "utf8")).toBe("retained");
    } finally {
      await scope.close();
    }
  });
});

it.each([
  { boundary: "archives", promptBlob: false, code: "EPERM" },
  { boundary: "unreferenced", promptBlob: false, code: "EACCES" },
  { boundary: "unreferenced", promptBlob: true, code: "EPERM" },
  { boundary: "budget", promptBlob: false, code: "EPERM" },
  { boundary: "budget", promptBlob: true, code: "EACCES" },
] as const)(
  "$boundary skips $code without counting failed deletions (promptBlob=$promptBlob)",
  async ({ boundary, promptBlob, code }) => {
    await withStoreDir(async (dir, storePath) => {
      await fs.writeFile(storePath, "{}");
      const paths: string[] = [];
      for (const [index, size] of [100, 60, 40].entries()) {
        const hash = String(index).repeat(64);
        const filePath = promptBlob
          ? path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2), `${hash}.txt`)
          : path.join(
              dir,
              boundary === "archives"
                ? `old-${index}.jsonl.deleted.2026-01-01T00-00-00.000Z`
                : `old-${index}.jsonl`,
            );
        await writeArtifact(
          filePath,
          size,
          index + 1,
          new Date(Date.now() - (30 - index) * 60_000),
        );
        paths.push(filePath);
      }
      const [blockedPath] = paths;
      if (!blockedPath) {
        throw new Error("expected oldest artifact path");
      }
      rejectRemoval(blockedPath, code);
      if (boundary === "archives") {
        expect.soft(await pruneArchives({ storePath, highWaterBytes: 102 })).toMatchObject({
          removedFiles: 2,
          usage: { totalBytes: 102 },
        });
        expect.soft(await pruneArchives({ storePath, highWaterBytes: 101 })).toMatchObject({
          removedFiles: 0,
          usage: { totalBytes: 102 },
        });
      } else if (boundary === "unreferenced") {
        const params = { store: {}, storePath, olderThanMs: 60_000 };
        expect.soft(await pruneOrphans(params)).toMatchObject({ removedFiles: 2, freedBytes: 100 });
        expect.soft(await pruneOrphans(params)).toMatchObject({ removedFiles: 0, freedBytes: 0 });
      } else {
        const result = await enforceBudget({
          store: {},
          storePath,
          maintenance: { maxDiskBytes: 150, highWaterBytes: 102 },
          warnOnly: false,
        });
        expect.soft(result).toMatchObject({
          removedFiles: 2,
          removedEntries: 0,
          freedBytes: 100,
          totalBytesBefore: 202,
          totalBytesAfter: 102,
        });
      }
      expect.soft(await fs.readFile(blockedPath)).toEqual(Buffer.alloc(100, 1));
      for (const filePath of paths.slice(1)) {
        expect.soft(nodeFs.existsSync(filePath)).toBe(false);
      }
      expect.soft((await measureUsage(storePath)).totalBytes).toBe(102);
    });
  },
);

it.each([
  { artifact: "transcript", code: "EPERM", mode: "enforce" },
  { artifact: "promptBlob", code: "EACCES", mode: "enforce" },
  { artifact: "all", code: "EPERM", mode: "enforce" },
  { artifact: "transcript", code: "EPERM", mode: "warn" },
] as const)(
  "continues eviction after $artifact deletion failure ($code, $mode)",
  async ({ artifact, code, mode }) => {
    await withStoreDir(async (dir, storePath) => {
      const hash = "a".repeat(64);
      const retainedStore = {
        [activeKey]: { sessionId: "active", updatedAt: 1 },
        [preservedKey]: { sessionId: "preserved", updatedAt: 1 },
        [laterKey]: archivedEntry("later", 3),
      } satisfies Record<string, SessionEntry>;
      const store: Record<string, SessionEntry> = {
        [oldKey]: archivedEntry("old", 2, {
          skillsSnapshot: {
            prompt: "",
            skills: [],
            promptRef: { algorithm: "sha256", version: 1, hash, bytes: 600 },
          },
        }),
        ...retainedStore,
      };
      const artifactFile = (kind: string, name: string, size: number, owner = oldKey) => ({
        kind,
        owner,
        file: path.join(dir, name),
        size,
      });
      const artifacts = [
        artifactFile("promptBlob", `skills-prompts/sha256/aa/${hash}.txt`, 600),
        artifactFile("transcript", "old.jsonl", 400),
        artifactFile("pointer", "old.trajectory-path.json", 80),
        artifactFile("trajectory", "old.trajectory.jsonl", 120),
        artifactFile("later", "later.jsonl", 1000, laterKey),
      ];
      for (const { file, size } of artifacts) {
        await writeArtifact(file, size);
      }
      for (const entry of [retainedStore[activeKey], retainedStore[preservedKey]]) {
        await fs.writeFile(path.join(dir, `${entry.sessionId}.jsonl`), Buffer.alloc(64));
      }
      const originalStoreJson = json(store);
      await fs.writeFile(storePath, originalStoreJson);
      const highWaterBytes = Buffer.byteLength(json(retainedStore)) + 2 * 64 + 1000;
      const blocked = artifacts.filter(({ kind }) => artifact === "all" || kind === artifact);
      const log = { warn: vi.fn(), info: vi.fn() };
      const commitEvictedIndex = vi.fn(async () => {
        await writeTextAtomic(storePath, json(store), { durable: true });
      });
      const attempted: string[] = [];
      const rmSpy = rejectRemoval(
        blocked.map(({ file }) => file),
        code,
        async (target) => {
          const candidate = artifacts.find(({ file }) => file === target);
          if (candidate) {
            const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
            expect.soft(persisted[candidate.owner]).toBeUndefined();
            expect
              .soft([persisted[activeKey], persisted[preservedKey]])
              .toEqual([retainedStore[activeKey], retainedStore[preservedKey]]);
            attempted.push(candidate.file);
          }
        },
      );
      const result = await enforceBudget({
        store,
        storePath,
        preserveKeys: new Set([preservedKey]),
        maintenance: budget(highWaterBytes),
        warnOnly: mode === "warn",
        commitEvictedIndex,
        log,
      });
      if (mode !== "enforce") {
        expect(commitEvictedIndex).not.toHaveBeenCalled();
        expect(rmSpy).not.toHaveBeenCalled();
        expect(await fs.readFile(storePath, "utf8")).toBe(originalStoreJson);
        await expectArtifacts(artifacts);
        expect(store).toEqual(JSON.parse(originalStoreJson));
        expect(result).toMatchObject({
          removedEntries: 0,
          removedFiles: 0,
          freedBytes: 0,
          totalBytesAfter: (await measureUsage(storePath)).totalBytes,
        });
        return;
      }
      const expectedStore: Record<string, SessionEntry> = { ...retainedStore };
      delete expectedStore[laterKey];
      expect.soft(JSON.parse(await fs.readFile(storePath, "utf8"))).toEqual(expectedStore);
      expect.soft(store).toEqual(expectedStore);
      expect.soft(attempted).toEqual(artifacts.map(({ file }) => file));
      const removed = artifacts.filter((candidate) => !blocked.includes(candidate));
      for (const { file } of removed) {
        expect.soft(nodeFs.existsSync(file)).toBe(false);
      }
      await expectArtifacts(blocked);
      const usage = await measureUsage(storePath);
      expect.soft(result).toMatchObject({
        removedEntries: 2,
        removedFiles: removed.length,
        freedBytes: removed.reduce((sum, file) => sum + file.size, 0),
        totalBytesAfter: usage.totalBytes,
      });
      const aboveTarget = artifact === "all";
      if (aboveTarget) {
        expect.soft(usage.totalBytes).toBeGreaterThan(highWaterBytes);
      } else {
        expect.soft(usage.totalBytes).toBeLessThanOrEqual(highWaterBytes);
      }
      expect.soft(log[aboveTarget ? "info" : "warn"]).not.toHaveBeenCalled();
      expect.soft(log[aboveTarget ? "warn" : "info"]).toHaveBeenCalledWith(
        aboveTarget
          ? "session disk budget still above high-water target after cleanup"
          : "applied session disk budget cleanup",
        expect.objectContaining({
          [aboveTarget ? "totalBytes" : "totalBytesAfter"]: usage.totalBytes,
        }),
      );
    });
  },
);

it("keeps newly persisted prompt bytes counted while continuing to the next victim", async () => {
  await withStoreDir(async (dir, storePath) => {
    const mainKey = "agent:main:main";
    const prompt = "p".repeat(600);
    const store: Record<string, SessionEntry> = {
      [oldKey]: archivedEntry("old", 1, { delivery: { kind: "none" } }),
      [laterKey]: archivedEntry("later", 2, {
        delivery: { kind: "none" },
        skillsSnapshot: { prompt, skills: [] },
      }),
      [mainKey]: { sessionId: "active", updatedAt: 3, delivery: { kind: "none" } },
    };
    const oldTranscript = path.join(dir, "old.jsonl");
    const laterTranscript = path.join(dir, "later.jsonl");
    await fs.writeFile(oldTranscript, Buffer.alloc(1000));
    await fs.writeFile(laterTranscript, Buffer.alloc(1000));
    await fs.writeFile(storePath, json(store));
    const projected = projectSessionStoreForPersistence({ storePath, store });
    const hash = createHash("sha256").update(prompt).digest("hex");
    const blobPath = path.join(dir, "skills-prompts", "sha256", hash.slice(0, 2), `${hash}.txt`);
    const retained = { ...projected.store };
    delete retained[oldKey];
    const highWaterBytes = Buffer.byteLength(json(retained)) + 1600;
    rejectRemoval(oldTranscript, "EPERM");
    const result = await enforceBudget({
      store,
      storePath,
      maintenance: budget(highWaterBytes),
      warnOnly: false,
      commitEvictedIndex: () => saveLegacySessionStore(storePath, store, { skipMaintenance: true }),
    });
    expect.soft(Object.keys(store)).toEqual([mainKey]);
    expect.soft(nodeFs.existsSync(laterTranscript)).toBe(false);
    expect(await fs.readFile(oldTranscript)).toEqual(Buffer.alloc(1000));
    expect(await fs.readFile(blobPath, "utf8")).toBe(prompt);
    const usage = await measureUsage(storePath);
    // Legacy persistence appends a newline; the budget models the JSON payload.
    expect.soft(result).toMatchObject({
      removedEntries: 2,
      removedFiles: 1,
      freedBytes: 1000,
      totalBytesAfter: usage.totalBytes - 1,
    });
    expect.soft(usage.totalBytes).toBeLessThanOrEqual(highWaterBytes);
  });
});

it("reports only successful orphan removals in the applied cleanup-service summary", async () => {
  await withOpenClawTestState({ label: "cleanup-removal-failure" }, async (state) => {
    const cfg = { session: { maintenance: { maxDiskBytes: false, pruneAfter: "1d" } } } as const;
    await state.writeConfig(cfg);
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      { sessionId: "active", updatedAt: Date.now() },
    );
    const blocked = path.join(state.sessionsDir(), "blocked.jsonl");
    const removable = path.join(state.sessionsDir(), "removable.jsonl");
    for (const [file, size] of [
      [blocked, 100],
      [removable, 60],
    ] as const) {
      await writeArtifact(file, size, 0);
    }
    rejectRemoval(blocked, "EACCES");
    const cleanup = (dryRun: boolean) =>
      runSessionsCleanup({
        cfg,
        opts: { dryRun, enforce: true },
        targets: [{ agentId: "main", storePath }],
      });
    const preview = await cleanup(true);
    const result = await cleanup(false);
    expect(preview.previewResults[0]?.summary.unreferencedArtifacts).toMatchObject({
      removedFiles: 2,
      freedBytes: 160,
    });
    expect(result.appliedSummaries[0]).toMatchObject({
      applied: true,
      beforeCount: 1,
      afterCount: 1,
      unreferencedArtifacts: { removedFiles: 1, freedBytes: 60 },
    });
    expect(await fs.readFile(blocked)).toEqual(Buffer.alloc(100));
    expect(nodeFs.existsSync(removable)).toBe(false);
  });
});
