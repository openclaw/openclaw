// Trajectory cleanup tests cover retention pruning of trajectory artifacts.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  removeRemovedSessionTrajectoryArtifacts,
  removeSessionTrajectoryArtifacts,
} from "./cleanup.js";
import { resolveTrajectoryFilePath, resolveTrajectoryPointerFilePath } from "./paths.js";
import {
  acquireTrajectoryWriterLease,
  canonicalizeTrajectoryPath,
  withTrajectoryPathLock,
} from "./writer-lifecycle.js";

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

describe("trajectory cleanup", () => {
  it("removes adjacent trajectory sidecars for a deleted session", async () => {
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
      });

      expect(removed.map((entry) => entry.kind).toSorted()).toEqual(["pointer", "runtime"]);
      await expectPathMissing(runtimeFile);
      await expectPathMissing(pointerPath);
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
      });

      await expectPathMissing(safeExternalRuntime);
      await expectPathMissing(pointerPath);

      await fs.writeFile(pointerPath, pointerFile(sessionId, unsafeExternalRuntime), "utf8");
      await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
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
      });

      expect(removed).toEqual([{ kind: "pointer", path: pointerPath }]);
      expect((await fs.stat(unrelatedTranscript)).isFile()).toBe(true);
      await expectPathMissing(pointerPath);
    });
  });

  it("continues best-effort cleanup when one artifact cannot be unlinked", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-4";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");
      const removeFailure = Object.assign(new Error("busy"), { code: "EBUSY" });
      const rmSpy = vi.spyOn(nodeFs.promises, "rm").mockRejectedValueOnce(removeFailure);

      try {
        const removed = await removeSessionTrajectoryArtifacts({
          sessionId,
          sessionFile,
          storePath,
          restrictToStoreDir: true,
        });

        expect(removed).toEqual([{ kind: "pointer", path: pointerPath }]);
        expect((await fs.stat(runtimeFile)).isFile()).toBe(true);
        await expectPathMissing(pointerPath);
      } finally {
        rmSpy.mockRestore();
      }
    });
  });

  it("retires the canonical path before unlinking the runtime file", async () => {
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
      });

      await expectPathMissing(leaseA.filePath);
      expect((await fs.stat(leaseB.filePath)).isFile()).toBe(true);
    });
  });

  it("does not admit a writer claim while a delete's unlink is still in flight", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-7";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const order: string[] = [];
      const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
      let releaseUnlink: () => void = () => {};
      const unlinkGate = new Promise<void>((resolve) => {
        releaseUnlink = resolve;
      });
      const rmSpy = vi
        .spyOn(nodeFs.promises, "rm")
        .mockImplementation(async (target: nodeFs.PathLike, options?: nodeFs.RmOptions) => {
          order.push("unlink-start");
          await unlinkGate;
          const result = await originalRm(target, options);
          order.push("unlink-done");
          return result;
        });

      try {
        const deletePromise = removeSessionTrajectoryArtifacts({
          sessionId,
          sessionFile,
          storePath,
          restrictToStoreDir: true,
        });

        // Let the delete turn's synchronous claim+retire run and reach the
        // paused unlink before attempting a concurrent claim.
        await new Promise<void>((resolve) => {
          setImmediate(() => resolve());
        });
        expect(order).toEqual(["unlink-start"]);

        const acquirePromise = acquireTrajectoryWriterLease({
          sessionId,
          candidatePath: runtimeFile,
        }).then((lease) => {
          order.push("acquire-done");
          return lease;
        });

        // The claim must queue behind the per-path lock, not run concurrently
        // with the paused unlink (P1-A) — give it every chance to (wrongly)
        // resolve early before asserting it hasn't.
        await new Promise<void>((resolve) => {
          setImmediate(() => resolve());
        });
        expect(order).toEqual(["unlink-start"]);

        releaseUnlink();
        const [, lease] = await Promise.all([deletePromise, acquirePromise]);

        expect(order.indexOf("unlink-done")).toBeLessThan(order.indexOf("acquire-done"));
        expect(lease.filePath).toBe(runtimeFile);
        // The claim was only admitted after delete's unlink fully committed,
        // so it cannot have reactivated or recreated the deleted artifact.
        await expectPathMissing(runtimeFile);
      } finally {
        rmSpy.mockRestore();
      }
    });
  });
});
