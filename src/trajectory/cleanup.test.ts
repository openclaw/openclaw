// Trajectory cleanup tests cover retention pruning of trajectory artifacts.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  removeRemovedSessionTrajectoryArtifacts,
  removeSessionTrajectoryArtifacts,
} from "./cleanup.js";
import { resolveTrajectoryFilePath, resolveTrajectoryPointerFilePath } from "./paths.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";
import {
  acquireTrajectoryWriterLease,
  canonicalizeTrajectoryPath,
  clearTrajectoryWriterLifecycleRegistryForTest,
  withTrajectoryPathLock,
} from "./writer-lifecycle.js";

afterEach(() => {
  // findTrajectoryPathOwnedBySession scans the whole registry by sessionId;
  // several tests below reuse the same literal sessionId strings ("abc*def"
  // etc.) across cases, so leaked entries from an earlier test can otherwise
  // shadow the current test's own owner record.
  clearTrajectoryWriterLifecycleRegistryForTest();
});

function runtimeEvent(sessionId: string): string {
  return `${JSON.stringify({
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "session.started",
    ts: "2026-04-22T08:00:00.000Z",
    seq: 1,
    sourceSeq: 1,
    sessionId,
  })}\n`;
}

function pointerFile(sessionId: string, runtimeFile: string): string {
  return `${JSON.stringify({
    traceSchema: "openclaw-trajectory-pointer",
    schemaVersion: 1,
    sessionId,
    runtimeFile,
  })}\n`;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let statError: unknown;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  expect((statError as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
}

async function findTombstone(
  originalPath: string,
  reason: "reset" | "deleted",
): Promise<string | undefined> {
  const dir = path.dirname(originalPath);
  const prefix = `${path.basename(originalPath)}.${reason}.`;
  const entries = await fs.readdir(dir).catch(() => []);
  const match = entries.find((name) => name.startsWith(prefix));
  return match ? path.join(dir, match) : undefined;
}

/** Asserts originalPath is gone and a matching tombstone now exists; returns its path. */
async function expectTombstoned(
  originalPath: string,
  reason: "reset" | "deleted",
): Promise<string> {
  await expectPathMissing(originalPath);
  const tombstone = await findTombstone(originalPath, reason);
  expect(tombstone).toBeDefined();
  return tombstone as string;
}

describe("trajectory cleanup", () => {
  it("tombstones adjacent trajectory sidecars into .deleted.<timestamp> for a deleted session", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-1";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const removed = await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      expect(removed.map((entry) => entry.kind).toSorted()).toEqual(["pointer", "runtime"]);
      const runtimeTombstone = await expectTombstoned(runtimeFile, "deleted");
      const pointerTombstone = await expectTombstoned(pointerPath, "deleted");
      expect(removed.map((entry) => entry.path).toSorted()).toEqual(
        [runtimeTombstone, pointerTombstone].toSorted(),
      );
    });
  });

  it("skips removed sessions still referenced by surviving store rows", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "shared-session";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const removed = await removeRemovedSessionTrajectoryArtifacts({
        removedSessionFiles: [[sessionId, sessionFile]],
        referencedSessionIds: new Set([sessionId]),
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      expect(removed).toStrictEqual([]);
      expect((await fs.stat(runtimeFile)).isFile()).toBe(true);
      expect((await fs.stat(pointerPath)).isFile()).toBe(true);
    });
  });

  it("only removes external pointer targets that prove they belong to the session", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-2";
      const sessionsDir = path.join(dir, "sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      const externalDir = path.join(dir, "external");
      await fs.mkdir(sessionsDir);
      await fs.mkdir(externalDir);
      const safeExternalRuntime = path.join(externalDir, `${sessionId}.jsonl`);
      const unsafeExternalRuntime = path.join(externalDir, "unsafe.jsonl");
      await fs.writeFile(safeExternalRuntime, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(unsafeExternalRuntime, runtimeEvent(sessionId), "utf8");

      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(pointerPath, pointerFile(sessionId, safeExternalRuntime), "utf8");
      await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      await expectTombstoned(safeExternalRuntime, "deleted");
      await expectTombstoned(pointerPath, "deleted");

      await fs.writeFile(pointerPath, pointerFile(sessionId, unsafeExternalRuntime), "utf8");
      await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      expect((await fs.stat(unsafeExternalRuntime)).isFile()).toBe(true);
    });
  });

  it("does not trust an unrelated pointer target merely because it is in the sessions dir", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-3";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, "custom-transcript.jsonl");
      const unrelatedTranscript = path.join(dir, `${sessionId}.jsonl`);
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(
        unrelatedTranscript,
        `${JSON.stringify({ type: "session", id: "unrelated-session" })}\n`,
        "utf8",
      );
      await fs.writeFile(pointerPath, pointerFile(sessionId, unrelatedTranscript), "utf8");

      const removed = await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      const pointerTombstone = await expectTombstoned(pointerPath, "deleted");
      expect(removed).toEqual([{ kind: "pointer", path: pointerTombstone }]);
      expect((await fs.stat(unrelatedTranscript)).isFile()).toBe(true);
    });
  });

  it("continues best-effort cleanup when one artifact cannot be archived", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-4";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");
      const archiveFailure = Object.assign(new Error("busy"), { code: "EBUSY" });
      const renameSpy = vi.spyOn(nodeFs.promises, "rename").mockRejectedValueOnce(archiveFailure);

      try {
        const removed = await removeSessionTrajectoryArtifacts({
          sessionId,
          sessionFile,
          storePath,
          restrictToStoreDir: true,
          disposal: { mode: "tombstone", reason: "deleted" },
        });

        const pointerTombstone = await expectTombstoned(pointerPath, "deleted");
        expect(removed).toEqual([{ kind: "pointer", path: pointerTombstone }]);
        // The runtime rename was the one made to fail — it stays exactly where
        // it was, not tombstoned, matching the best-effort contract.
        expect((await fs.stat(runtimeFile)).isFile()).toBe(true);
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  it("retires the canonical path before archiving the runtime file", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-5";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const canonicalPath = canonicalizeTrajectoryPath(runtimeFile);
      const incarnationBefore = await withTrajectoryPathLock(
        canonicalPath,
        (ctx) => ctx.currentIncarnation,
      );

      await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      const afterRemoval = await withTrajectoryPathLock(canonicalPath, (ctx) => ctx);
      expect(afterRemoval.retired).toBe(true);
      expect(afterRemoval.currentIncarnation).toBeGreaterThan(incarnationBefore);
    });
  });

  it("does not cross-delete a colliding sibling session's disambiguated file", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const trajectoryDir = path.join(dir, "traces");
      const sessionAId = "abc*def";
      const sessionBId = "abc_def";
      const sessionFileA = path.join(dir, "session-a.jsonl");
      const sessionFileB = path.join(dir, "session-b.jsonl");
      const env = { OPENCLAW_TRAJECTORY_DIR: trajectoryDir };

      const leaseA = await acquireTrajectoryWriterLease({
        sessionId: sessionAId,
        candidatePath: resolveTrajectoryFilePath({ env, sessionId: sessionAId }),
      });
      const leaseB = await acquireTrajectoryWriterLease({
        sessionId: sessionBId,
        candidatePath: resolveTrajectoryFilePath({ env, sessionId: sessionBId }),
      });
      expect(leaseA.filePath).not.toBe(leaseB.filePath);

      await fs.mkdir(trajectoryDir, { recursive: true });
      await fs.writeFile(leaseA.filePath, runtimeEvent(sessionAId), "utf8");
      await fs.writeFile(leaseB.filePath, runtimeEvent(sessionBId), "utf8");
      const pointerPathA = resolveTrajectoryPointerFilePath(sessionFileA);
      const pointerPathB = resolveTrajectoryPointerFilePath(sessionFileB);
      await fs.writeFile(pointerPathA, pointerFile(sessionAId, leaseA.filePath), "utf8");
      await fs.writeFile(pointerPathB, pointerFile(sessionBId, leaseB.filePath), "utf8");

      await removeSessionTrajectoryArtifacts({
        sessionId: sessionAId,
        sessionFile: sessionFileA,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      await expectTombstoned(leaseA.filePath, "deleted");
      expect((await fs.stat(leaseB.filePath)).isFile()).toBe(true);
    });
  });

  it("removes the disambiguated owner's own runtime and pointer on its own delete", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const trajectoryDir = path.join(dir, "traces");
      const sessionAId = "abc*def";
      const sessionBId = "abc_def";
      const sessionFileA = path.join(dir, "session-a.jsonl");
      const sessionFileB = path.join(dir, "session-b.jsonl");
      const env = { OPENCLAW_TRAJECTORY_DIR: trajectoryDir };

      const leaseA = await acquireTrajectoryWriterLease({
        sessionId: sessionAId,
        candidatePath: resolveTrajectoryFilePath({ env, sessionId: sessionAId }),
      });
      const leaseB = await acquireTrajectoryWriterLease({
        sessionId: sessionBId,
        candidatePath: resolveTrajectoryFilePath({ env, sessionId: sessionBId }),
      });
      expect(leaseA.filePath).not.toBe(leaseB.filePath);

      await fs.mkdir(trajectoryDir, { recursive: true });
      await fs.writeFile(leaseA.filePath, runtimeEvent(sessionAId), "utf8");
      await fs.writeFile(leaseB.filePath, runtimeEvent(sessionBId), "utf8");
      const pointerPathA = resolveTrajectoryPointerFilePath(sessionFileA);
      const pointerPathB = resolveTrajectoryPointerFilePath(sessionFileB);
      await fs.writeFile(pointerPathA, pointerFile(sessionAId, leaseA.filePath), "utf8");
      await fs.writeFile(pointerPathB, pointerFile(sessionBId, leaseB.filePath), "utf8");

      // Delete the DISAMBIGUATED owner (B) this time — the reverse of the
      // sibling test above. B's own runtime file lives at a hash-suffixed
      // path its own default-derivation never produces, so cleanup must
      // resolve it via the registry's owner record, not by re-deriving B's
      // (wrong) default candidate.
      await removeSessionTrajectoryArtifacts({
        sessionId: sessionBId,
        sessionFile: sessionFileB,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      await expectTombstoned(leaseB.filePath, "deleted");
      await expectTombstoned(pointerPathB, "deleted");
      expect((await fs.stat(leaseA.filePath)).isFile()).toBe(true);
    });
  });

  it("does not admit a writer claim while a delete's archive-rename is still in flight", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-7";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const order: string[] = [];
      const originalRename = nodeFs.promises.rename.bind(nodeFs.promises);
      let releaseArchive: () => void = () => {};
      const archiveGate = new Promise<void>((resolve) => {
        releaseArchive = resolve;
      });
      const renameSpy = vi
        .spyOn(nodeFs.promises, "rename")
        .mockImplementation(async (src: nodeFs.PathLike, dest: nodeFs.PathLike) => {
          order.push("archive-start");
          await archiveGate;
          const result = await originalRename(src, dest);
          order.push("archive-done");
          return result;
        });

      try {
        const deletePromise = removeSessionTrajectoryArtifacts({
          sessionId,
          sessionFile,
          storePath,
          restrictToStoreDir: true,
          disposal: { mode: "tombstone", reason: "deleted" },
        });

        // Let the delete turn's synchronous claim+retire run and reach the
        // paused archive rename before attempting a concurrent claim.
        await new Promise<void>((resolve) => {
          setImmediate(() => resolve());
        });
        expect(order).toEqual(["archive-start"]);

        const acquirePromise = acquireTrajectoryWriterLease({
          sessionId,
          candidatePath: runtimeFile,
        }).then((lease) => {
          order.push("acquire-done");
          return lease;
        });

        // The claim must queue behind the per-path lock, not run concurrently
        // with the paused archive rename (P1-A) — give it every chance to
        // (wrongly) resolve early before asserting it hasn't.
        await new Promise<void>((resolve) => {
          setImmediate(() => resolve());
        });
        expect(order).toEqual(["archive-start"]);

        releaseArchive();
        const [, lease] = await Promise.all([deletePromise, acquirePromise]);

        expect(order.indexOf("archive-done")).toBeLessThan(order.indexOf("acquire-done"));
        expect(lease.filePath).toBe(runtimeFile);
        // The claim was only admitted after delete's archive rename fully
        // committed, so it cannot have reactivated or recreated the tombstoned
        // artifact — the original path is free and a fresh tombstone exists.
        await expectTombstoned(runtimeFile, "deleted");
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  it("keeps a queued re-acquisition's fresh runtime and pointer intact against a racing delete's pointer archive", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-8";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const order: string[] = [];
      const originalRename = nodeFs.promises.rename.bind(nodeFs.promises);
      let releasePointerArchive: () => void = () => {};
      const pointerArchiveGate = new Promise<void>((resolve) => {
        releasePointerArchive = resolve;
      });
      const renameSpy = vi
        .spyOn(nodeFs.promises, "rename")
        .mockImplementation(async (src: nodeFs.PathLike, dest: nodeFs.PathLike) => {
          const isPointerTarget = String(src) === pointerPath;
          if (isPointerTarget) {
            order.push("pointer-archive-start");
            await pointerArchiveGate;
          }
          const result = await originalRename(src, dest);
          if (isPointerTarget) {
            order.push("pointer-archive-done");
          }
          return result;
        });

      try {
        const deletePromise = removeSessionTrajectoryArtifacts({
          sessionId,
          sessionFile,
          storePath,
          restrictToStoreDir: true,
          disposal: { mode: "tombstone", reason: "deleted" },
        });

        // Let delete's locked turn archive the runtime file and reach the
        // paused pointer archive — still inside the SAME turn once fixed —
        // before attempting a concurrent re-acquisition for the same
        // session (ordering (B) from the round-4 finding). The runtime
        // file's own (unpaused) rename is real disk I/O, so poll rather
        // than assume a fixed number of ticks.
        for (let attempt = 0; attempt < 50 && order.length === 0; attempt += 1) {
          await new Promise<void>((resolve) => {
            setImmediate(() => resolve());
          });
        }
        expect(order).toEqual(["pointer-archive-start"]);

        const recorderPromise = createTrajectoryRuntimeRecorder({ sessionId, sessionFile });

        await new Promise<void>((resolve) => {
          setImmediate(() => resolve());
        });
        expect(order).toEqual(["pointer-archive-start"]);

        releasePointerArchive();
        const [, recorder] = await Promise.all([deletePromise, recorderPromise]);
        if (!recorder) {
          throw new Error("expected trajectory runtime recorder");
        }
        recorder.recordEvent("prompt.submitted", { marker: "post-race-owner" });
        await recorder.flush();

        // Delete's OWN pair tombstoned (the runtime rename already completed
        // unpaused, before this test even started polling for pointer-archive-start).
        await findTombstone(runtimeFile, "deleted").then((tombstone) =>
          expect(tombstone).toBeDefined(),
        );
        await findTombstone(pointerPath, "deleted").then((tombstone) =>
          expect(tombstone).toBeDefined(),
        );

        // The NEW owner's fresh pair is live at the original (now-vacant) paths.
        const pointerContent = JSON.parse(nodeFs.readFileSync(pointerPath, "utf8")) as {
          runtimeFile?: string;
        };
        expect(pointerContent.runtimeFile).toBe(recorder.filePath);
        expect(nodeFs.existsSync(recorder.filePath)).toBe(true);
        expect(nodeFs.readFileSync(recorder.filePath, "utf8")).toContain("post-race-owner");
      } finally {
        renameSpy.mockRestore();
      }
    });
  });
});
