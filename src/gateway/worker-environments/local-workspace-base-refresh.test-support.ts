import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { prepareLocalWorkspaceCheckout } from "./local-workspace-checkout.js";
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
}) {
  const { owner, canonical } = params;
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
      for (const [name, commit] of [
        ["before", sourceHead],
        ["after", selectedBase],
      ] as const) {
        await prepareLocalWorkspaceCheckout({
          source: canonical,
          destination: path.join(checkouts, name),
          temporaryRoot: checkouts,
          baseCommit: commit,
          branch: "refresh",
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
      }
      const baseline = await state.baselineDocument();
      const refreshed = await prepareWorkspaceBaseRefresh({
        beforeRoot: path.join(checkouts, "before"),
        afterRoot: path.join(checkouts, "after"),
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
  // The next turn is stopped before writing; the bytes it inherited must stay applied.
  stopAt.stage = "projection-journal";
  await expect(withLocalWorkspaceProjection(owner, (state) => state.reuse())).rejects.toThrow(
    "turn stopped",
  );
  expect(await readSource(projection)).toBe("refreshed\n");
  stopAt.stage = undefined;
  await withLocalWorkspaceProjection(owner, (state) => state.reuse());
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    base_commit: selectedBase,
    pending_ref: null,
    pending_target: null,
    journal_json: null,
  });
  expect(await readSource(canonical)).toBe("refreshed\n");
  expect(await readSource(projection)).toBe("refreshed\n");
}
