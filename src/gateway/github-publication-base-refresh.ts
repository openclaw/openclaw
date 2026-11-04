import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTextAtomic } from "@openclaw/fs-safe/atomic";
import type { SessionGitHubBaseRefreshResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { resolveGitMetadataPath } from "../agents/worktrees/git.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import {
  assertSafeGitPublicationWorkspace,
  captureSettledGitHubPublicationWorkspaceSnapshot,
  createGitHubPublicationCommandRunner,
  readGitHubPublicationBaseSha,
  requireGitHubPublicationCommit,
} from "./github-publication-git-transport.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";
import {
  prepareManagedWorkspaceReviewBase,
  readManagedSandboxGitState,
} from "./github-publication-workspace-review.js";
import { prepareLocalWorkspaceCheckout } from "./worker-environments/local-workspace-checkout.js";
import { withLocalWorkspaceProjection } from "./worker-environments/local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "./worker-environments/local-workspace-types.js";
import {
  captureWorkspaceManifestDocument,
  prepareWorkspaceBaseRefresh,
  workspaceSnapshotsEqual,
} from "./worker-environments/workspace-manifest-worker.js";
import { localWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";
import {
  deleteStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./worker-environments/workspace-result-staging.js";

/** The host owns merge ancestry; the projection owns only admitted source bytes. */
type ManagedWorkspaceIntegrationParams = {
  owner: LocalWorkspaceOwner;
  identity: PreparedGitHubPublicationIdentity;
  sandbox: SandboxContext;
  signal?: AbortSignal;
  assertCurrent: () => void;
  conflictsResolved?: boolean;
  baseCommit?: string;
};

type VerifiedWorkspaceSource = {
  repository: string;
  branch: string;
  commit: string;
  githubHost: string;
  resuming: boolean;
  accept: () => Promise<void>;
};

export function refreshManagedWorkspaceBase(
  params: ManagedWorkspaceIntegrationParams,
): Promise<SessionGitHubBaseRefreshResult> {
  return integrateManagedWorkspaceSource(params);
}

/** Explicit sources come from current GitHub verification, never editable workspace remotes. */
export async function integrateManagedWorkspaceSource(
  params: ManagedWorkspaceIntegrationParams & {
    verifiedBase?: VerifiedWorkspaceSource;
    source?: VerifiedWorkspaceSource & {
      review: { repository: string; commit: string };
      projectBase?: { repository: string; branch: string };
      initial: boolean;
      reviewOnly: boolean;
      emptySource: boolean;
    };
  },
): Promise<SessionGitHubBaseRefreshResult> {
  const { owner, identity, sandbox } = params;
  const integrationSource = params.source ?? params.verifiedBase;
  const action = params.source ? "prepare_pr" : "refresh_base";
  const reviewPreparationError = `Source integration is saved, but sandbox review-base preparation failed. Resolve any pending sandbox Git merge or index lock, then retry ${action} before tests and Auto Review.`;
  const attribution = await prepareGitCoauthorAttribution({
    agentId: owner.agentId,
    sessionId: owner.sessionId,
    sessionKey: owner.sessionKey,
    config: currentGitHubPublicationConfig(),
    excludeAccountId: identity.account.accountId,
  });
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    owner.assertCurrent();
    params.assertCurrent();
    if (!attribution.isCurrent()) {
      throw new Error(`Contributor credit changed; retry ${action}.`);
    }
  };
  const message = (subject: string) =>
    [
      subject,
      ...(attribution.attribution?.trailers.length
        ? ["", ...attribution.attribution.trailers]
        : []),
    ].join("\n");
  const { run } = createGitHubPublicationCommandRunner(assertCurrent);
  await assertSafeGitPublicationWorkspace(owner.worktree.path, run);
  const target = integrationSource
    ? {
        repository: integrationSource.repository,
        baseBranch: integrationSource.branch,
        githubHost: integrationSource.githubHost,
      }
    : await prepareGitHubPublicationTarget({
        worktree: owner.worktree,
        session: {
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          sessionId: owner.sessionId,
          lifecycleRevision: owner.lifecycleRevision,
        },
        identity,
        assertCurrent,
      });
  const initialImport = params.source?.initial === true;
  let guestHead: string | undefined;
  let guestDirty = false;
  let pendingStaged: { path: string; indexEntry?: string }[] = [];
  const stagedError =
    "Commit the staged changes in files that also have unstaged changes before refreshing this PR; its existing files and index were preserved.";
  if (integrationSource && !params.source?.reviewOnly) {
    if (integrationSource.resuming) {
      // An accepted transfer may retain a paused runtime. Recover it through its
      // owner before asking that runtime to execute the workspace check.
      await withLocalWorkspaceProjection({ ...owner, assertCurrent }, (state) => state.settle());
    }
    const observed = await readManagedSandboxGitState({
      sandbox,
      signal: params.signal,
      assertCurrent,
    });
    guestHead = observed.head;
    guestDirty = observed.dirty;
    if (!initialImport && observed.partiallyStaged.length) {
      if (!integrationSource.resuming) {
        throw new Error(stagedError);
      }
      // Checked against the pending integration below.
      pendingStaged = observed.partiallyStaged;
    }
  }
  let previousBase: string | undefined;
  const result = await withLocalWorkspaceProjection<SessionGitHubBaseRefreshResult>(
    { ...owner, assertCurrent },
    async (state) => {
      if (
        sandbox.sessionKey !== owner.sessionKey ||
        sandbox.workspaceDir !== state.current().projection_path ||
        !sandbox.backend
      ) {
        throw new Error("The base refresh sandbox no longer belongs to this workspace.");
      }
      // A destination change selects a comparison, not a source to merge or stage.
      if (params.source?.reviewOnly) {
        previousBase = state.current().base_commit ?? undefined;
        return {
          status: "current",
          repository: target.repository,
          baseBranch: target.baseBranch,
          baseCommit: params.source.commit,
          changedPaths: [],
          conflictPaths: [],
        };
      }
      // This operation prepares an existing private checkout; it never creates a new binding.
      state.current();
      await state.settle();
      previousBase = state.current().base_commit ?? undefined;
      const check = () => {
        state.current();
      };
      return await withWorktreeGitConfig<SessionGitHubBaseRefreshResult>(
        owner.worktree.path,
        true,
        { beforeRun: check },
        async (policy) => {
          const cwd = owner.worktree.path;
          const env = {
            GIT_AUTHOR_NAME: identity.account.login,
            GIT_COMMITTER_NAME: identity.account.login,
            GIT_AUTHOR_EMAIL: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
            GIT_COMMITTER_EMAIL: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
          };
          const git = (args: string[], input?: string) =>
            policy.require(cwd, args, { env, input, beforeRun: check });
          const probe = (args: string[]) => policy.run(cwd, args, { env, beforeRun: check });
          if (
            integrationSource &&
            (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])) !== owner.worktree.branch
          ) {
            throw new Error("The managed workspace branch changed; existing work was preserved.");
          }
          const stagedRef = localWorkspaceBaseRefreshRef(
            createHash("sha256").update(owner.worktree.id).digest("hex"),
          );
          // Settlement above finishes reserved transfers. The lease owns this one
          // remaining, unreserved slot; its payload must use the current baseline.
          await deleteStagedWorkerWorkspaceResult({
            root: cwd,
            stagedResultRef: stagedRef,
            assertCurrent: check,
          });
          const pending = await probe(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
          if (pending.code !== 0 && pending.code !== 1) {
            throw new Error("Workspace base integration state is unavailable.");
          }
          let baseCommit = pending.code === 0 ? pending.stdout.trim() : undefined;
          if (baseCommit && params.source && baseCommit !== params.source.commit) {
            throw new Error(
              "Another source integration is pending. Finish it before preparing this PR; saved work was preserved.",
            );
          }
          if (baseCommit && state.current().base_commit !== baseCommit) {
            // Settlement above finishes reserved transfers. Native-only preparation has
            // applied no source bytes; restart it so later guest edits enter the snapshot.
            await git(["merge", "--quit"]);
            baseCommit = undefined;
          }
          if (params.conflictsResolved && (!baseCommit || params.baseCommit !== baseCommit)) {
            throw new Error(
              `The pending source integration changed; call ${action} again and resolve its returned conflicts.`,
            );
          }
          const continuingIntegration = Boolean(baseCommit);
          // A refresh rewrites working files before the guest index is restaged, so a refreshed file
          // stays staged at its pre-refresh entry, which ORIG_HEAD records until the next source is
          // admitted. Any other staged-only entry is guest work that completion would replace.
          const stagedSnapshot = pendingStaged.length
            ? (await probe(["rev-parse", "--verify", "--quiet", "ORIG_HEAD"])).stdout.trim()
            : "";
          for (const entry of pendingStaged) {
            const listed = stagedSnapshot
              ? await probe(["ls-tree", "-z", "--full-tree", stagedSnapshot, "--", entry.path])
              : undefined;
            const recorded = listed?.stdout
              .split("\0")
              .find((line) => line.slice(line.indexOf("\t") + 1) === entry.path);
            if (!entry.indexEntry || recorded?.split("\t")[0] !== entry.indexEntry) {
              throw new Error(stagedError);
            }
          }
          if (!baseCommit) {
            if (params.baseCommit) {
              throw new Error(
                `The expected commit acknowledges an existing conflict; it cannot select a source.`,
              );
            }
            baseCommit =
              integrationSource?.commit ??
              (await readGitHubPublicationBaseSha(
                run,
                target.repository,
                target.baseBranch,
                target.githubHost,
                identity.env,
              ));
          }
          const initialHead = await git(["rev-parse", "HEAD"]);
          const recoveredImport =
            initialImport &&
            params.source?.resuming === true &&
            (continuingIntegration ||
              (initialHead === baseCommit && state.current().base_commit === baseCommit));
          const prepareContents = (commit: string, commitPresent: boolean) =>
            requireGitHubPublicationCommit(
              run,
              target.repository,
              commit,
              target.githubHost,
              cwd,
              {
                ...identity.env,
                GIT_CONFIG_GLOBAL: gitNullConfigPath(),
                GIT_CONFIG_SYSTEM: gitNullConfigPath(),
              },
              `The selected repository base contents could not be fetched; retry ${action}.`,
              { contents: true, commitPresent },
            );
          await prepareContents(baseCommit, continuingIntegration);
          if (initialImport && !recoveredImport) {
            const source = params.source!;
            const pristineError =
              "This workspace has existing dirty, untracked, or unpublished work. Keep or finish that work separately before preparing this PR; no PR source was applied.";
            const admittedPaths = await state.canonicalPaths();
            const snapshot = await captureSettledGitHubPublicationWorkspaceSnapshot(
              { cwd, assertCurrent: check },
              policy,
              admittedPaths,
            );
            const headTree = await git(["rev-parse", "HEAD^{tree}"]);
            if (
              initialHead !== state.current().base_commit ||
              guestHead !== initialHead ||
              guestDirty ||
              snapshot.sourceIndexTree !== headTree ||
              snapshot.workspaceTree !== headTree
            ) {
              throw new Error(pristineError);
            }
            // A projection may first be captured after unrelated commits already exist.
            // Only verified published history or the immutable empty source is disposable.
            if (source.emptySource) {
              if (initialHead !== (await git(["rev-parse", "refs/heads/main"]))) {
                throw new Error(pristineError);
              }
            } else {
              await requireGitHubPublicationCommit(
                run,
                source.review.repository,
                source.review.commit,
                target.githubHost,
                cwd,
                {
                  ...identity.env,
                  GIT_CONFIG_GLOBAL: gitNullConfigPath(),
                  GIT_CONFIG_SYSTEM: gitNullConfigPath(),
                },
                `The selected PR base ancestry could not be fetched; retry ${action}.`,
              );
              const fromBase = await probe([
                "merge-base",
                "--is-ancestor",
                initialHead,
                source.review.commit,
              ]);
              const fromHead = await probe([
                "merge-base",
                "--is-ancestor",
                initialHead,
                baseCommit,
              ]);
              if (fromBase.code !== 0 && fromHead.code !== 0) {
                // The selected project source may be newer than, or differ from, the PR base.
                // Verify its recorded branch on the original repository, including forks.
                if (!source.projectBase) {
                  throw new Error(pristineError);
                }
                const publishedBase = await readGitHubPublicationBaseSha(
                  run,
                  source.projectBase.repository,
                  source.projectBase.branch,
                  target.githubHost,
                  identity.env,
                );
                await requireGitHubPublicationCommit(
                  run,
                  source.projectBase.repository,
                  publishedBase,
                  target.githubHost,
                  cwd,
                  {
                    ...identity.env,
                    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
                    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
                  },
                  `The current repository base ancestry could not be fetched; retry ${action}.`,
                );
                const fromPublishedBase = await probe([
                  "merge-base",
                  "--is-ancestor",
                  initialHead,
                  publishedBase,
                ]);
                if (fromPublishedBase.code !== 0) {
                  throw new Error(pristineError);
                }
              }
            }
            const buildCacheInputs = new Set(await state.buildCacheInputs());
            const canonical = await captureWorkspaceManifestDocument({
              root: cwd,
              baseCommit: state.current().base_commit,
              includePaths: admittedPaths,
              buildCacheInputs,
              signal: params.signal,
            });
            const projection = await captureWorkspaceManifestDocument({
              root: state.current().projection_path,
              baseCommit: state.current().base_commit,
              buildCacheInputs,
              signal: params.signal,
            });
            check();
            const equal = await workspaceSnapshotsEqual(
              canonical,
              projection,
              [...buildCacheInputs],
              params.signal,
            );
            check();
            if (!equal) {
              throw new Error(pristineError);
            }
          }
          const mergeBases = async (left: string, right: string) => {
            const bases = await probe(["merge-base", "--all", left, right]);
            if (bases.code === 1) {
              return [];
            }
            if (bases.code !== 0) {
              throw new Error("The selected base ancestry could not be verified.");
            }
            return bases.stdout.trim().split(/\s+/u);
          };
          const inputs = initialImport ? [] : await mergeBases("HEAD", baseCommit);
          if (!initialImport && !inputs.length) {
            throw new Error("The selected base could not be integrated; saved work was preserved.");
          }
          const discovered = new Set([baseCommit, ...inputs]);
          // Git combines multiple merge bases using their own common ancestors.
          // Prepare that closure of trees without fetching every historical file version.
          for (let index = 0; index < inputs.length; index++) {
            const input = inputs[index]!;
            if (input !== baseCommit) {
              await prepareContents(input, true);
            }
            for (let previous = 0; previous < index; previous++) {
              for (const ancestor of await mergeBases(input, inputs[previous]!)) {
                if (!discovered.has(ancestor)) {
                  discovered.add(ancestor);
                  inputs.push(ancestor);
                }
              }
            }
          }
          // Do not reserve a source that cannot be integrated or whose ancestry is unavailable.
          await integrationSource?.accept();
          check();
          if (!continuingIntegration) {
            await state.synchronize("canonical");
            await state.synchronize("projection");
            const ancestor = await probe(["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
            if (ancestor.code === 0 && (!initialImport || initialHead === baseCommit)) {
              return {
                status: "current",
                repository: target.repository,
                baseBranch: target.baseBranch,
                baseCommit,
                changedPaths: [],
                conflictPaths: [],
              };
            }
            if (ancestor.code !== 0 && ancestor.code !== 1) {
              throw new Error("The selected base ancestry could not be verified.");
            }
            const snapshot = await captureSettledGitHubPublicationWorkspaceSnapshot(
              { cwd, assertCurrent: check },
              policy,
              await state.canonicalPaths(),
            );
            if (
              !initialImport &&
              snapshot.workspaceTree !== (await git(["rev-parse", "HEAD^{tree}"]))
            ) {
              // Index-only installation preserves every working byte, including accepted ignored data.
              await git(["read-tree", snapshot.workspaceTree]);
              await git([
                "-c",
                "core.hooksPath=" + os.devNull,
                "commit",
                "--no-gpg-sign",
                "-m",
                message("Save workspace before refreshing its selected base"),
              ]);
            }
          }
          const integrated = await probe(["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
          if (integrated.code === 0 && (!initialImport || initialHead === baseCommit)) {
            // A native commit may have moved HEAD before its merge-state cleanup completed.
            await git(["merge", "--quit"]);
            return {
              status: "current",
              repository: target.repository,
              baseBranch: target.baseBranch,
              baseCommit,
              changedPaths: [],
              conflictPaths: [],
            };
          }
          if (integrated.code !== 0 && integrated.code !== 1) {
            throw new Error("The pending base ancestry could not be verified.");
          }
          const sourceHead = await git(["rev-parse", "HEAD"]);
          const merge = initialImport
            ? { code: 0, stdout: await git(["rev-parse", `${baseCommit}^{tree}`]) }
            : await probe([
                "merge-tree",
                "--write-tree",
                "--name-only",
                "-z",
                sourceHead,
                baseCommit,
              ]);
          if (merge.code !== 0 && merge.code !== 1) {
            throw new Error("The selected base could not be integrated; saved work was preserved.");
          }
          const fields = merge.stdout.split("\0");
          const tree = fields.shift()!;
          if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(tree)) {
            throw new Error("Git returned an invalid base integration tree.");
          }
          const conflictPaths: string[] = [];
          if (merge.code === 1) {
            for (const field of fields) {
              if (!field) {
                break;
              }
              conflictPaths.push(field);
            }
          }
          const changedPaths = (
            await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sourceHead, tree])
          )
            .split("\0")
            .filter(Boolean);
          if (state.current().base_commit !== baseCommit) {
            const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-base-refresh-"));
            try {
              const mergedCommit = await git(
                ["commit-tree", "--no-gpg-sign", tree, "-p", sourceHead],
                "Prepare selected base integration\n",
              );
              for (const [name, commit] of [
                ["before", sourceHead],
                ["after", mergedCommit],
              ]) {
                const destination = path.join(temporary, name!);
                await prepareLocalWorkspaceCheckout({
                  source: cwd,
                  destination,
                  temporaryRoot: temporary,
                  baseCommit: commit!,
                  branch: "refresh",
                  signal: new AbortController().signal,
                  assertCurrent: check,
                });
              }
              const buildCacheInputs = await state.buildCacheInputs();
              const baseline = await state.baselineDocument();
              const current = await prepareWorkspaceBaseRefresh(
                {
                  beforeRoot: path.join(temporary, "before"),
                  afterRoot: path.join(temporary, "after"),
                  baseCommit,
                  baseRaw: baseline.rawManifest,
                  baseRef: baseline.manifestRef,
                  buildCacheInputs,
                  action,
                },
                params.signal,
              );
              await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
                root: cwd,
                stagingRoot: path.join(temporary, "after"),
                stagedResultRef: stagedRef,
                baseManifestRef: baseline.manifestRef,
                baseManifestRaw: baseline.rawManifest,
                currentManifestRef: current.manifestRef,
                currentManifestRaw: current.rawManifest,
                buildCacheInputs: current.buildCacheInputs,
                assertCurrent: check,
              });
            } finally {
              await fs.rm(temporary, { recursive: true, force: true });
            }
            // The retained source payload precedes native merge state and all file effects.
            if (!baseCommit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit)) {
              throw new Error("Invalid pending base commit.");
            }
            // MERGE_HEAD is a native pseudoref; Git rejects updating it through update-ref.
            const mergeHead = await resolveGitMetadataPath(cwd, "MERGE_HEAD", { beforeRun: check });
            if (integrationSource && !continuingIntegration) {
              await git(["update-ref", "ORIG_HEAD", sourceHead]);
            }
            check();
            await writeTextAtomic(mergeHead, baseCommit, {
              mode: 0o600,
              trailingNewline: true,
              beforeRename: async () => check(),
            });
            await git(["update-ref", "AUTO_MERGE", tree]);
            await state.applyBaseRefresh(stagedRef);
            await git(["read-tree", tree]);
          } else {
            await state.synchronize("canonical");
          }
          if (conflictPaths.length && !params.conflictsResolved) {
            return {
              status: "conflicts",
              repository: target.repository,
              baseBranch: target.baseBranch,
              baseCommit,
              changedPaths,
              conflictPaths,
            };
          }
          const snapshot = await captureSettledGitHubPublicationWorkspaceSnapshot(
            { cwd, assertCurrent: check },
            policy,
            await state.canonicalPaths(),
          );
          const markers = await probe(["diff", "--check", sourceHead, "--", ...conflictPaths]);
          if (conflictPaths.length && markers.stdout.includes("conflict marker")) {
            throw new Error(
              `Conflict markers remain. Resolve the reported files, then repeat ${action} with conflictsResolved and the same returned commit before tests and Auto Review.`,
            );
          }
          await git(["read-tree", snapshot.workspaceTree]);
          if (initialImport) {
            const original = await git(["rev-parse", "--verify", "ORIG_HEAD^{commit}"]);
            const currentHead = await git(["rev-parse", "HEAD"]);
            if (currentHead !== baseCommit) {
              if (currentHead !== original) {
                throw new Error(
                  "The workspace Git head changed during PR preparation; saved work was preserved.",
                );
              }
              await git([
                "update-ref",
                `refs/heads/${owner.worktree.branch}`,
                baseCommit,
                original,
              ]);
            }
            await git(["merge", "--quit"]);
          } else {
            await git([
              "-c",
              "core.hooksPath=" + os.devNull,
              "commit",
              "--no-gpg-sign",
              "-m",
              message(`Merge selected base ${target.baseBranch}`),
            ]);
          }
          await state.synchronize("projection");
          return {
            status: "refreshed",
            repository: target.repository,
            baseBranch: target.baseBranch,
            baseCommit,
            changedPaths,
            conflictPaths: [],
          };
        },
      );
    },
  );
  if (result.status === "conflicts") {
    return result;
  }
  let reviewCommit = result.baseCommit;
  if (params.source) {
    const source = params.source;
    await requireGitHubPublicationCommit(
      run,
      params.source.review.repository,
      params.source.review.commit,
      target.githubHost,
      owner.worktree.path,
      {
        ...identity.env,
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
        GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      },
      reviewPreparationError,
      { contents: true },
    );
    // Importing an older PR head does not merge the current base tip into its files.
    // Review its changes from their common ancestor, not as deletions of newer base work.
    reviewCommit = await withWorktreeGitConfig(
      owner.worktree.path,
      true,
      { beforeRun: assertCurrent },
      (git) =>
        git.require(owner.worktree.path, ["merge-base", "HEAD", source.review.commit], {
          beforeRun: assertCurrent,
        }),
    );
    await requireGitHubPublicationCommit(
      run,
      params.source.review.repository,
      reviewCommit,
      target.githubHost,
      owner.worktree.path,
      {
        ...identity.env,
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
        GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      },
      reviewPreparationError,
      { contents: true, commitPresent: true },
    );
  }
  const review = await prepareManagedWorkspaceReviewBase({
    owner,
    sandbox,
    reviewCommit,
    previousBase,
    signal: params.signal,
    assertCurrent,
    stageChanges: !params.source?.reviewOnly,
    reviewPreparationError,
  });
  if (params.source?.reviewOnly) {
    // Keep the old binding retryable until its new comparison is installed.
    await params.source.accept();
  }
  return { ...result, review };
}
