import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { createWorkspaceReconcileMetrics } from "./workspace-hash-memo.js";
import { prepareLocalWorkspaceReconciliation } from "./workspace-local-reconciliation.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function prepareUnchangedWorkspace(options?: {
  localContent?: string;
  assertCurrent?: () => void;
  beforeRemoteFence?: () => Promise<void>;
  onRenew?: (root: string) => Promise<void>;
}) {
  const root = tempDirs.make("openclaw-unchanged-reconciliation-");
  const stagingRoot = tempDirs.make("openclaw-unchanged-reconciliation-staging-");
  await fs.writeFile(path.join(root, "result.txt"), "base\n");
  const base = await captureWorkspaceManifest({ root, baseCommit: null });
  if (options?.localContent) {
    await fs.writeFile(path.join(root, "result.txt"), options.localContent);
  }
  const ref = workerWorkspaceResultRef("unchanged-result");
  const journal = {
    load: async () => undefined,
    begin: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const record = vi.fn();
  const publishAcceptedManifest = vi.fn();
  const verifyStable = vi.fn(async () => {
    await options?.beforeRemoteFence?.();
  });
  const reconcile = await prepareLocalWorkspaceReconciliation({
    request: {
      localPath: root,
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: base.manifestRef,
      journal,
      stagedResult: { ref, record },
      assertCurrent: options?.assertCurrent,
    },
    hashMemo: new Map(),
    metrics: createWorkspaceReconcileMetrics(),
  });
  const raw = serializeWorkerWorkspaceManifest(base.manifest);
  const reconciliation = await reconcile({
    stagingRoot,
    base: base.manifest,
    current: base.manifest,
    baseRaw: raw,
    currentRaw: raw,
    currentManifestRef: base.manifestRef,
    manifestRef: () => base.manifestRef,
    publishAcceptedManifest,
    verifyStable,
  });
  const quiescence = {
    assertActive: vi.fn(async () => {
      await options?.onRenew?.(root);
    }),
    resume: vi.fn(async () => {}),
  };
  return {
    root,
    base,
    ref,
    journal,
    record,
    publishAcceptedManifest,
    verifyStable,
    reconciliation,
    quiescence,
  };
}

describe("unchanged local workspace reconciliation", () => {
  it.each([undefined, "local change\n"])(
    "finalizes durable result refs with local content %j",
    async (localContent) => {
      const f = await prepareUnchangedWorkspace({ localContent });
      const { root, base, ref, reconciliation, quiescence, journal } = f;
      const hasRef = (stagedResultRef: string) =>
        hasWorkerWorkspaceResultRef({ root, stagedResultRef });
      const prepared = preparedWorkerWorkspaceResultRef(ref);
      if (localContent) {
        expect(reconciliation.changed).toBe(false);
        expect(reconciliation.acceptUnchangedStagedResult).toBeUndefined();
      } else {
        expect(reconciliation.acceptUnchangedStagedResult).toBeTypeOf("function");
        expect(f.verifyStable).not.toHaveBeenCalled();
        expect(journal.commit).not.toHaveBeenCalled();
        await expect(hasRef(prepared)).resolves.toBe(true);
        expect(f.record).not.toHaveBeenCalled();
      }
      const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
      expect(f.verifyStable).toHaveBeenCalledTimes(localContent ? 3 : 1);
      expect(quiescence.assertActive).toHaveBeenCalledTimes(localContent ? 2 : 1);
      expect(f.publishAcceptedManifest).toHaveBeenCalledTimes(localContent ? 1 : 0);
      expect(journal.commit).toHaveBeenCalledExactlyOnceWith(applied?.manifestRef);
      if (localContent) {
        expect(applied?.manifestRef).not.toBe(base.manifestRef);
        await expect(fs.readFile(path.join(root, "result.txt"), "utf8")).resolves.toBe(
          localContent,
        );
      } else {
        expect(applied).toMatchObject({ manifestRef: base.manifestRef, conflictPaths: [] });
        expect(journal.begin).not.toHaveBeenCalled();
        expect(f.record).toHaveBeenCalledExactlyOnceWith(ref);
        expect(await readStagedWorkerWorkspaceResult(root, ref)).toMatchObject({
          baseManifestRef: base.manifestRef,
          currentManifestRef: base.manifestRef,
          changed: false,
        });
        await expect(hasRef(prepared)).resolves.toBe(false);
      }
    },
  );

  it.each(["remote", "local", "owner"] as const)(
    "rejects a late %s change after renewal without accepting the result",
    async (side) => {
      let current = true;
      let remoteChanged = false;
      const f = await prepareUnchangedWorkspace({
        assertCurrent: () => {
          if (!current) {
            throw new Error("stale result owner");
          }
        },
        onRenew: async (root) => {
          if (side === "local") {
            await fs.writeFile(path.join(root, "result.txt"), "late local write\n");
          } else if (side === "remote") {
            remoteChanged = true;
          }
        },
        beforeRemoteFence: async () => {
          if (side === "owner") {
            current = false;
          }
          if (remoteChanged) {
            throw new Error("late remote write");
          }
        },
      });
      const final = verifyReconciledWorkspaceFinal(f.reconciliation, f.quiescence);
      if (side === "owner") {
        await expect(final).rejects.toThrow("stale result owner");
      } else {
        await expect(final).rejects.toMatchObject({ reclaimDisposition: "retry" });
      }
      expect(f.journal.commit).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
      if (side !== "owner") {
        for (const stagedResultRef of [f.ref, preparedWorkerWorkspaceResultRef(f.ref)]) {
          await expect(
            hasWorkerWorkspaceResultRef({ root: f.root, stagedResultRef }),
          ).resolves.toBe(false);
        }
      }
    },
  );
});
