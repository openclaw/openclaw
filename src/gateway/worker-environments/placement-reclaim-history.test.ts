import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { createCommandTest } from "../../../test/helpers/command-fixture.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { runExec } from "../../process/exec.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { manifestFor } from "./workspace-recovery.test-support.js";
import {
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useStateDatabaseTempDirs();
const it = createCommandTest();

it.each(["reclaim", "reclaim recovery", "ordinary turn recovery"] as const)(
  "adopts commits only for reclaim and preserves dirty files during %s",
  async (mode) => {
    setRuntimeConfigSnapshot({});
    const root = tempDirs.make("openclaw-reclaim-history-");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const workspacePath = path.join(root, "history-workspace");
    const stagingRoot = path.join(root, "history-result");
    await fs.mkdir(workspacePath);
    await fs.mkdir(stagingRoot);
    const git = async (args: string[], input?: string) =>
      (
        await runExec("git", ["-c", "commit.gpgSign=false", "-C", workspacePath, ...args], {
          input,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
    await git(["init", "--quiet", "-b", "managed"]);
    await git(["config", "user.name", "Workspace Test"]);
    await git(["config", "user.email", "workspace@example.invalid"]);
    await fs.writeFile(path.join(workspacePath, "result.txt"), "base\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const baseCommit = await git(["rev-parse", "HEAD"]);
    const base = { ...(await manifestFor(workspacePath)), baseCommit };
    const baseManifestRaw = JSON.stringify(base);
    const baseManifestRef = `sha256:${createHash("sha256").update(baseManifestRaw).digest("hex")}`;
    await git(["checkout", "--quiet", "-b", "worker"]);
    await fs.writeFile(path.join(workspacePath, "result.txt"), "worker commit\n");
    await git(["commit", "--quiet", "-am", "worker change"]);
    const headCommit = await git(["rev-parse", "HEAD"]);
    const packPrefix = path.join(root, "worker-history");
    const packHash = await git(
      ["pack-objects", "--revs", packPrefix],
      `${headCommit}\n^${baseCommit}\n`,
    );
    await git(["checkout", "--quiet", "managed"]);
    await fs.writeFile(path.join(stagingRoot, "result.txt"), "worker commit\nuncommitted edit\n");
    const currentManifestRaw = JSON.stringify({ ...(await manifestFor(stagingRoot)), baseCommit });
    const currentManifestRef = `sha256:${createHash("sha256").update(currentManifestRaw).digest("hex")}`;
    const harness = await createHarness(database, placementStore, { workspacePath });
    const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
    vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
      const tunnel = await startTunnel(request);
      tunnel.syncWorkspace = async () => ({
        mode: "git",
        remoteWorkspaceDir: "/worker/workspace",
        manifestRef: baseManifestRef,
      });
      tunnel.reconcileWorkspace = async (reconcile) => {
        if (reconcile.source.kind !== "local") {
          throw new Error("Expected a Gateway-source workspace");
        }
        const prepared = await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
          request: {
            localPath: workspacePath,
            remoteWorkspaceDir: reconcile.remoteWorkspaceDir,
            baseManifestRef: reconcile.baseManifestRef,
            journal: reconcile.source.journal,
            stagedResult: reconcile.source.stagedResult,
            assertCurrent: reconcile.source.assertCurrent,
          },
          stagingRoot,
          baseManifestRaw,
          currentManifestRaw,
          currentManifestRef,
          gitHistory: { baseCommit, headCommit, descendsFromBase: true },
          gitPackPath: `${packPrefix}-${packHash}.pack`,
        });
        return {
          ...prepared,
          changed: true,
          manifestRef: currentManifestRef,
          verifyStable: async () => {},
        };
      };
      return tunnel;
    });
    const destroy = vi.mocked(harness.environments.destroy).getMockImplementation()!;
    const expectedHead = mode === "ordinary turn recovery" ? baseCommit : headCommit;
    vi.mocked(harness.environments.destroy).mockImplementation(async (...args) => {
      expect(await git(["rev-parse", "HEAD"])).toBe(expectedHead);
      return await destroy(...args);
    });

    const active = await harness.service.dispatch(REQUEST);
    if (mode === "reclaim") {
      await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({ state: "reclaimed" });
    } else {
      if (active.state !== "active") {
        throw new Error("Expected an active worker");
      }
      const reclaim = mode === "reclaim recovery";
      if (reclaim) {
        await placementStore.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      }
      const claimId = reclaim ? "reclaim-history" : "ordinary-history";
      const claimInput = {
        ...REQUEST,
        claimId,
        runId: claimId,
        owner: placementTurnOwner(active),
      };
      const claim = reclaim
        ? await placementStore.claimReclaimWorkspaceResult(claimInput)
        : await placementStore.claimTurn(claimInput);
      await placementStore.markWorkspaceResultPending(claim);
      const stagedResultRef = workerWorkspaceResultRef(claimId);
      await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root: workspacePath,
        stagingRoot,
        stagedResultRef,
        baseManifestRef,
        currentManifestRef,
        baseManifestRaw,
        currentManifestRaw,
        gitHistory: { baseCommit, headCommit, descendsFromBase: true },
        gitPackPath: `${packPrefix}-${packHash}.pack`,
      });
      await placementStore.recordStagedWorkspaceResult(claim, stagedResultRef);
      await placementStore.handoffWorkspaceResultRecovery(claim);
      await harness.service.reconcile();
    }
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(await git(["rev-parse", "HEAD"])).toBe(expectedHead);
    expect(await git(["status", "--porcelain"])).toBe("M result.txt");
    expect(await fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).toBe(
      "worker commit\nuncommitted edit\n",
    );
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
  },
);
