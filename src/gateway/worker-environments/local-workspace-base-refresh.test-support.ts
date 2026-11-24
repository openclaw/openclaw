import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi, type Mock } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import * as localWorkspaceStore from "./local-workspace-store.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { prepareWorkspaceBaseRefresh } from "./workspace-manifest-worker.js";
import { localWorkspaceBaseRefreshRef } from "./workspace-result-inventory.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

/** Each stopped turn revokes the projection pass at its next durable effect. */
export async function proveResumedBaseRefresh(params: {
  owner: LocalWorkspaceOwner;
  root: string;
  repo: string;
  canonical: string;
  log: Mock<(message: string) => void>;
}) {
  const { owner, canonical } = params;
  params.log.mockClear();
  const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
  const readSource = (root: string) => fs.readFile(path.join(root, "source.txt"), "utf8");
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const sourceHead = await git(canonical, "rev-parse", "HEAD");
  await fs.writeFile(path.join(params.repo, "source.txt"), "refreshed\n");
  await git(params.repo, "commit", "--quiet", "-am", "selected base");
  const selectedBase = await git(params.repo, "rev-parse", "HEAD");
  const stopAt = { stage: "projection-acceptance" as string | undefined };
  const withStore = localWorkspaceStore.withLocalWorkspaceStore;
  vi.spyOn(localWorkspaceStore, "withLocalWorkspaceStore").mockImplementation((options, run) =>
    withStore(options, (store) =>
      run({
        ...store,
        update: async (row, patch, authority, manifest) => {
          const stage =
            patch.base_commit === selectedBase
              ? "projection-acceptance"
              : typeof patch.journal_json === "string" && row.pending_target === "projection"
                ? "projection-journal"
                : undefined;
          if (stage && stage === stopAt.stage) {
            throw new Error("turn stopped");
          }
          return await store.update(row, patch, authority, manifest);
        },
      }),
    ),
  );
  const stagedRef = localWorkspaceBaseRefreshRef(
    createHash("sha256").update(owner.worktree.id).digest("hex"),
  );
  // Same staging as refresh_base: canonical accepts, then the projection pass is stopped.
  await expect(
    withLocalWorkspaceProjection(owner, async (state) => {
      const checkouts = await fs.mkdtemp(path.join(params.root, "refresh-"));
      const baseline = await state.baselineDocument();
      const refreshed = await prepareWorkspaceBaseRefresh({
        root: canonical,
        beforeTree: sourceHead,
        afterTree: selectedBase,
        temporaryRoot: checkouts,
        baseCommit: selectedBase,
        baseRaw: baseline.rawManifest,
        baseRef: baseline.manifestRef,
        buildCacheInputs: await state.buildCacheInputs(),
        action: "refresh_base",
      });
      await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root: canonical,
        stagingRoot: path.join(checkouts, "after"),
        stagedResultRef: stagedRef,
        baseManifestRef: baseline.manifestRef,
        baseManifestRaw: baseline.rawManifest,
        currentManifestRef: refreshed.manifestRef,
        currentManifestRaw: refreshed.rawManifest,
        buildCacheInputs: refreshed.buildCacheInputs,
        assertCurrent: () => {},
      });
      await state.applyBaseRefresh(stagedRef);
    }),
  ).rejects.toThrow("indeterminate");
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    pending_target: "projection",
  });
  expect(await readSource(projection)).toBe("refreshed\n");
  // Acceptance retries must not journal files already applied by the interrupted turn.
  stopAt.stage = "projection-journal";
  await withLocalWorkspaceProjection(owner, (state) => state.reuse());
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    base_commit: selectedBase,
    pending_ref: null,
    pending_target: null,
    journal_json: null,
  });
  expect(await readSource(canonical)).toBe("refreshed\n");
  expect(await readSource(projection)).toBe("refreshed\n");
  const lines = params.log.mock.calls.map(([line]) => line);
  const starts = lines.filter((line) => line.startsWith("Local workspace reconcile start:"));
  const finishes = lines.filter((line) => line.startsWith("Local workspace reconcile finish:"));
  expect(finishes.map((line) => /outcome=(\w+)/u.exec(line)?.[1])).toEqual([
    "applied",
    "aborted",
    "replayed",
  ]);
  expect(starts).toHaveLength(3);
  expect(new Set(starts.map((line) => /"plan":"([a-f0-9]{16})"/u.exec(line)?.[1])).size).toBe(1);
  expect(new Set(starts.map((line) => /"attempt":"([a-f0-9-]+)"/u.exec(line)?.[1])).size).toBe(3);
  for (const [index, start] of starts.entries()) {
    const correlation = start.split("correlation=")[1];
    expect(finishes[index]).toContain(`correlation=${correlation} outcome=`);
    expect(start).toMatch(/"baseCommit":"[a-f0-9]{12}","targetCommit":"[a-f0-9]{12}"/u);
    expect(start).not.toContain(owner.worktree.id);
    expect(start).not.toContain(canonical);
  }
}
