import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { BrokerChild } from "../../process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../../process/spawn-broker/pipe.js";
import * as diagnostics from "../../process/spawn-diagnostics.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { sha256 } from "./workspace-manifest-fixtures.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { applyWorkspacePatch, createWorkspacePatch } from "./workspace-reconcile-recovery.js";
import {
  expectWorkspaceFiles,
  gitInit,
  manifestFor,
  writeWorkspaceFiles,
} from "./workspace-recovery.test-support.js";
import {
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState();
});

it.skipIf(!supportsSpawnBrokerCommandTransport())(
  "reconciles and stages exact bytes without redundant Git commands",
  async () => {
    const root = tempDirs.make("workspace-spawn-base-");
    const stagingRoot = tempDirs.make("workspace-spawn-current-");
    const oldFiles = { binary: Buffer.from([0, 255, 13, 10]), removed: "old\n" };
    const newFiles = { binary: Buffer.from([255, 0, 10, 13]), "new ü": "new\r\n" };
    await writeWorkspaceFiles(root, oldFiles);
    await writeWorkspaceFiles(stagingRoot, newFiles);
    await gitInit(root);
    const base = await manifestFor(root);
    const current = await manifestFor(stagingRoot);
    const host = createSpawnBrokerHost();
    await host.ready();
    try {
      const launches = vi.spyOn(diagnostics, "recordChildProcessSpawn");
      const gitLaunches = () =>
        launches.mock.calls.filter(([command]) => path.basename(command) === "git");
      await runWithSpawnBroker(host, async () => {
        const snapshot = await createWorkspacePatch({
          root,
          stagingRoot,
          baseEntries: base.entries,
          appliedEntries: current.entries,
        });
        expect(gitLaunches()).toHaveLength(5);
        expect(gitLaunches().filter(([, child]) => !(child instanceof BrokerChild))).toHaveLength(
          2,
        );
        launches.mockClear();
        const empty = await createWorkspacePatch({
          root,
          stagingRoot,
          baseEntries: [],
          appliedEntries: [],
        });
        expect(empty.patch.byteLength).toBe(0);
        expect(empty.baseTree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
        expect(gitLaunches()).toHaveLength(3);
        expect(gitLaunches().filter(([, child]) => !(child instanceof BrokerChild))).toHaveLength(
          1,
        );
        await applyWorkspacePatch({ root, patch: snapshot.patch });
        await expectWorkspaceFiles(root, newFiles);
        await expect(fs.stat(path.join(root, "removed"))).rejects.toMatchObject({ code: "ENOENT" });
        const stagedResultRef = "refs/openclaw/worker-results/spawn-proof";
        launches.mockClear();
        await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
          root,
          stagingRoot,
          stagedResultRef,
          baseManifestRef: `sha256:${sha256(serializeWorkerWorkspaceManifest(base))}`,
          currentManifestRef: `sha256:${sha256(serializeWorkerWorkspaceManifest(current))}`,
          baseManifestRaw: serializeWorkerWorkspaceManifest(base),
          currentManifestRaw: serializeWorkerWorkspaceManifest(current),
        });
        expect(gitLaunches()).toHaveLength(2);
        expect(gitLaunches().filter(([, child]) => !(child instanceof BrokerChild))).toHaveLength(
          1,
        );
        const staged = await readStagedWorkerWorkspaceResult(root, stagedResultRef);
        expect(staged.current).toEqual(current);
        for await (const { entry, content } of staged.readEntries()) {
          expect(content).toEqual(
            Uint8Array.from(Buffer.from(newFiles[entry.path as keyof typeof newFiles])),
          );
        }
      });
    } finally {
      await host.close();
    }
  },
);
