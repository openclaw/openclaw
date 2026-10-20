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
import { prepareLocalWorkspaceCheckout } from "./worker-environments/local-workspace-checkout.js";
import { withLocalWorkspaceProjection } from "./worker-environments/local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "./worker-environments/local-workspace-types.js";
import { prepareWorkerWorkspaceGitPack } from "./worker-environments/workspace-git-base.js";
import { manifestNodes, sameEntry } from "./worker-environments/workspace-manifest-comparison.js";
import { applyWorkspaceSourceOverlay } from "./worker-environments/workspace-manifest-overlay.js";
import { captureWorkspaceSnapshot } from "./worker-environments/workspace-manifest-worker.js";
import {
  MAX_RECONCILIATION_PACK_BYTES,
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./worker-environments/workspace-manifest.js";
import { localWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";
import {
  deleteStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./worker-environments/workspace-result-staging.js";

/** The host owns merge ancestry; the projection owns only admitted source bytes. */
export async function refreshManagedWorkspaceBase(params: {
  owner: LocalWorkspaceOwner;
  identity: PreparedGitHubPublicationIdentity;
  sandbox: SandboxContext;
  signal?: AbortSignal;
  assertCurrent: () => void;
  conflictsResolved?: boolean;
  baseCommit?: string;
}): Promise<SessionGitHubBaseRefreshResult> {
  const { owner, identity, sandbox } = params;
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
      throw new Error("Contributor credit changed; retry refresh_base.");
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
  const target = await prepareGitHubPublicationTarget({
    worktree: owner.worktree,
    identity,
    assertCurrent,
  });
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
      // This operation prepares an existing private checkout; it never creates a new binding.
      state.current();
      await state.settle();
      previousBase = state.current().base_commit ?? undefined;
      const check = () => {
        assertCurrent();
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
          if (baseCommit && state.current().base_commit !== baseCommit) {
            // Settlement above finishes reserved transfers. Native-only preparation has
            // applied no source bytes; restart it so later guest edits enter the snapshot.
            await git(["merge", "--quit"]);
            baseCommit = undefined;
          }
          if (params.conflictsResolved && (!baseCommit || params.baseCommit !== baseCommit)) {
            throw new Error(
              "The pending base integration changed; call refresh_base again and resolve its returned baseCommit.",
            );
          }
          const continuingIntegration = Boolean(baseCommit);
          if (!baseCommit) {
            if (params.baseCommit) {
              throw new Error(
                "baseCommit acknowledges an existing conflict; it cannot select a base.",
              );
            }
            await state.synchronize("canonical");
            await state.synchronize("projection");
            baseCommit = await readGitHubPublicationBaseSha(
              run,
              target.repository,
              target.baseBranch,
              target.githubHost,
              identity.env,
            );
          }
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
              "The selected repository base contents could not be fetched; retry refresh_base.",
              { contents: true, commitPresent },
            );
          await prepareContents(baseCommit, continuingIntegration);
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
          const inputs = await mergeBases("HEAD", baseCommit);
          if (!inputs.length) {
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
          if (!continuingIntegration) {
            const ancestor = await probe(["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
            if (ancestor.code === 0) {
              return {
                status: "current",
                repository: target.repository,
                baseBranch: target.baseBranch,
                baseCommit,
                changedPaths: [],
                conflictPaths: [],
              };
            }
            if (ancestor.code !== 1) {
              throw new Error("The selected base ancestry could not be verified.");
            }
            const snapshot = await captureSettledGitHubPublicationWorkspaceSnapshot(
              { cwd, assertCurrent: check },
              policy,
              await state.canonicalPaths(),
            );
            if (snapshot.workspaceTree !== (await git(["rev-parse", "HEAD^{tree}"]))) {
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
          if (integrated.code === 0) {
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
          if (integrated.code !== 1) {
            throw new Error("The pending base ancestry could not be verified.");
          }
          const sourceHead = await git(["rev-parse", "HEAD"]);
          const merge = await probe([
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
              const snapshots = [];
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
                snapshots.push(await captureWorkspaceSnapshot({ root: destination, baseCommit }));
              }
              const buildCacheInputs = await state.buildCacheInputs();
              const accepted = parseWorkerWorkspaceManifest(
                state.current().baseline_json!,
                state.current().baseline_ref!,
                buildCacheInputs,
              );
              const before = snapshots[0]!.manifest;
              const current = applyWorkspaceSourceOverlay(before, accepted, snapshots[1]!.manifest);
              current.buildCacheInputs = [
                ...new Set([
                  ...buildCacheInputs,
                  ...snapshots[1]!.manifest.entries.map((entry) => entry.path),
                ]),
              ];
              const priorNodes = manifestNodes(before);
              const currentNodes = manifestNodes(current);
              for (const [file, entry] of manifestNodes(accepted)) {
                if (!priorNodes.has(file) && !sameEntry(entry, currentNodes.get(file))) {
                  throw new Error(
                    `The selected base conflicts with saved workspace data at ${file}; move that saved file before retrying refresh_base.`,
                  );
                }
              }
              const currentRaw = serializeWorkerWorkspaceManifest(current);
              await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
                root: cwd,
                stagingRoot: path.join(temporary, "after"),
                stagedResultRef: stagedRef,
                baseManifestRef: state.current().baseline_ref!,
                baseManifestRaw: state.current().baseline_json!,
                currentManifestRef:
                  "sha256:" + createHash("sha256").update(currentRaw).digest("hex"),
                currentManifestRaw: currentRaw,
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
              "Conflict markers remain. Resolve the reported files, then repeat refresh_base with conflictsResolved and the same baseCommit before tests and Auto Review.",
            );
          }
          await git(["read-tree", snapshot.workspaceTree]);
          await git([
            "-c",
            "core.hooksPath=" + os.devNull,
            "commit",
            "--no-gpg-sign",
            "-m",
            message(`Merge selected base ${target.baseBranch}`),
          ]);
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
  // The guest can confirm only snapshots selected by the host. An arbitrary
  // guest donor could expose host-only data through Git's thin-pack deltas.
  const candidates = [
    ...new Set([result.baseCommit, previousBase].filter((base) => base !== undefined)),
  ];
  assertCurrent();
  const available = await sandbox.backend!.runShellCommand({
    script: FIND_REVIEW_BASE,
    args: [sandbox.containerWorkdir, ...candidates],
    signal: params.signal,
  });
  assertCurrent();
  if (available.code !== 0) {
    throw new Error(REVIEW_BASE_PREPARATION_ERROR);
  }
  const advertised = available.stdout.toString().trim();
  const retainedCommit = candidates.find((candidate) => candidate === advertised);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-review-base-"));
  try {
    for (const retained of retainedCommit ? [retainedCommit, undefined] : [undefined]) {
      const temporaryRoot = path.join(temporary, retained ? "retained" : "full");
      await fs.mkdir(temporaryRoot);
      const pack = await withWorktreeGitConfig(
        owner.worktree.path,
        true,
        { beforeRun: assertCurrent },
        (git) =>
          git.withContentEnvironment((baseEnv) =>
            prepareWorkerWorkspaceGitPack({
              root: owner.worktree.path,
              baseCommit: result.baseCommit,
              retainedCommit: retained,
              temporaryRoot,
              signal: params.signal ?? new AbortController().signal,
              baseEnv,
            }),
          ),
      );
      const size = (await fs.stat(pack)).size;
      if (size > MAX_RECONCILIATION_PACK_BYTES) {
        throw new Error(
          "The selected review base exceeds the sandbox transfer limit; saved integration is retained.",
        );
      }
      const input = await fs.readFile(pack);
      assertCurrent();
      const imported = await sandbox.backend!.runShellCommand({
        script: IMPORT_REVIEW_BASE,
        allowFailure: true,
        args: [sandbox.containerWorkdir, result.baseCommit, retained ? "retained" : "full"],
        stdin: input,
        signal: params.signal,
      });
      assertCurrent();
      if (imported.code === 0) {
        return { ...result, review: { mode: "local", base: result.baseCommit } };
      }
      // Missing donor objects can invalidate a thin pack or leave omitted source
      // objects unavailable. Retry the authorized full snapshot before staging.
      if (!retained || imported.code !== 75) {
        throw new Error(REVIEW_BASE_PREPARATION_ERROR);
      }
    }
    throw new Error(REVIEW_BASE_PREPARATION_ERROR);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const REVIEW_BASE_PREPARATION_ERROR =
  "Source integration is saved, but sandbox review-base preparation failed. Resolve any pending sandbox Git merge or index lock, then retry refresh_base before tests and Auto Review.";

const REVIEW_BASE_GIT = String.raw`set -eu
export GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
cd "$1"
test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"
if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
  exit 1
fi
`;

const FIND_REVIEW_BASE =
  REVIEW_BASE_GIT +
  String.raw`
shift
for candidate do
  if git cat-file -e "$candidate^{commit}" 2>/dev/null; then
    printf '%s\n' "$candidate"
    break
  fi
done
`;

const IMPORT_REVIEW_BASE =
  REVIEW_BASE_GIT +
  String.raw`
base="$2"
git index-pack --stdin --fix-thin >/dev/null || exit 75
if test "$3" = retained; then
  git rev-list --objects --no-object-names --missing=error "$base^{tree}" >/dev/null || exit 75
fi
missing_parent=false
for parent in $(git cat-file -p "$base" | sed -n '/^$/q; s/^parent //p'); do
  git cat-file -e "$parent^{commit}" 2>/dev/null || missing_parent=true
done
if "$missing_parent"; then
  shallow=$(git rev-parse --git-path shallow)
  if ! test -f "$shallow" || ! grep -Fxq "$base" "$shallow"; then
    (set -C; : > "$shallow.lock")
    trap 'rm -f "$shallow.lock"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if test -f "$shallow"; then cat "$shallow" > "$shallow.lock"; fi
    printf '%s\n' "$base" >> "$shallow.lock"
    mv "$shallow.lock" "$shallow"
    trap - EXIT HUP INT TERM
  fi
fi
git update-ref refs/openclaw/review-base "$base"
filters=$(git config --name-only --get-regexp '^filter\..*\.(clean|smudge|process|required)$' || test "$?" = 1)
set -- -c core.hooksPath=/dev/null -c core.fsmonitor=false
for key in $filters; do set -- "$@" -c "$key="; done
git "$@" add -A -- .
`;
