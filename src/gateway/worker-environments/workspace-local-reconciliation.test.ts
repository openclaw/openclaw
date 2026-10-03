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
  it("keeps durable result refs with one remote verification after final renewal", async () => {
    const fixture = await prepareUnchangedWorkspace();
    const { root, base, ref, reconciliation, quiescence, journal } = fixture;
    expect(reconciliation.acceptUnchangedStagedResult).toBeTypeOf("function");
    expect(fixture.verifyStable).not.toHaveBeenCalled();
    expect(journal.commit).not.toHaveBeenCalled();
    await expect(
      hasWorkerWorkspaceResultRef({ root, stagedResultRef: preparedWorkerWorkspaceResultRef(ref) }),
    ).resolves.toBe(true);
    expect(fixture.record).not.toHaveBeenCalled();

    const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);

    expect(applied).toMatchObject({ manifestRef: base.manifestRef, conflictPaths: [] });
    expect(fixture.verifyStable).toHaveBeenCalledOnce();
    expect(quiescence.assertActive).toHaveBeenCalledOnce();
    expect(journal.begin).not.toHaveBeenCalled();
    expect(journal.commit).toHaveBeenCalledExactlyOnceWith(base.manifestRef);
    expect(fixture.publishAcceptedManifest).not.toHaveBeenCalled();
    expect(fixture.record).toHaveBeenCalledExactlyOnceWith(ref);
    const staged = await readStagedWorkerWorkspaceResult(root, ref);
    expect(staged).toMatchObject({
      baseManifestRef: base.manifestRef,
      currentManifestRef: base.manifestRef,
      changed: false,
    });
    await expect(
      hasWorkerWorkspaceResultRef({ root, stagedResultRef: preparedWorkerWorkspaceResultRef(ref) }),
    ).resolves.toBe(false);
  });

  it("keeps the full apply path when only the remote workspace is unchanged", async () => {
    const fixture = await prepareUnchangedWorkspace({ localContent: "local change\n" });
    expect(fixture.reconciliation.changed).toBe(false);
    expect(fixture.reconciliation.acceptUnchangedStagedResult).toBeUndefined();

    const applied = await verifyReconciledWorkspaceFinal(
      fixture.reconciliation,
      fixture.quiescence,
    );

    expect(applied?.manifestRef).not.toBe(fixture.base.manifestRef);
    expect(fixture.verifyStable).toHaveBeenCalledTimes(3);
    expect(fixture.quiescence.assertActive).toHaveBeenCalledTimes(2);
    expect(fixture.publishAcceptedManifest).toHaveBeenCalledOnce();
    expect(fixture.journal.commit).toHaveBeenCalledExactlyOnceWith(applied?.manifestRef);
    await expect(fs.readFile(path.join(fixture.root, "result.txt"), "utf8")).resolves.toBe(
      "local change\n",
    );
  });

  it.each(["remote", "local"] as const)(
    "rejects a late %s write after the final renewal without accepting the result",
    async (side) => {
      let remoteChanged = false;
      const fixture = await prepareUnchangedWorkspace({
        onRenew: async (root) => {
          if (side === "local") {
            await fs.writeFile(path.join(root, "result.txt"), "late local write\n");
          } else {
            remoteChanged = true;
          }
        },
        beforeRemoteFence: async () => {
          if (remoteChanged) {
            throw new Error("late remote write");
          }
        },
      });

      await expect(
        verifyReconciledWorkspaceFinal(fixture.reconciliation, fixture.quiescence),
      ).rejects.toMatchObject({ reclaimDisposition: "retry" });

      expect(fixture.journal.commit).not.toHaveBeenCalled();
      expect(fixture.record).not.toHaveBeenCalled();
      await expect(
        hasWorkerWorkspaceResultRef({ root: fixture.root, stagedResultRef: fixture.ref }),
      ).resolves.toBe(false);
      await expect(
        hasWorkerWorkspaceResultRef({
          root: fixture.root,
          stagedResultRef: preparedWorkerWorkspaceResultRef(fixture.ref),
        }),
      ).resolves.toBe(false);
    },
  );

  it("revalidates the result owner before committing an unchanged workspace", async () => {
    let current = true;
    const fixture = await prepareUnchangedWorkspace({
      assertCurrent: () => {
        if (!current) {
          throw new Error("stale result owner");
        }
      },
      beforeRemoteFence: async () => {
        current = false;
      },
    });

    await expect(
      verifyReconciledWorkspaceFinal(fixture.reconciliation, fixture.quiescence),
    ).rejects.toThrow("stale result owner");

    expect(fixture.journal.commit).not.toHaveBeenCalled();
    expect(fixture.record).not.toHaveBeenCalled();
  });
});
