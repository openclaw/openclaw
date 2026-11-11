import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import {
  createGitHubPublicationCommandRunner,
  readGitHubPublicationBaseSha,
  requireGitHubPublicationCommit,
} from "./github-publication-git-transport.js";
import { withLocalWorkspaceProjection } from "./worker-environments/local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "./worker-environments/local-workspace-types.js";

export type VerifiedWorkspaceSource = {
  repository: string;
  branch: string;
  commit: string;
  githubHost: string;
  resuming: boolean;
  verify: () => Promise<void>;
  accept: () => Promise<void>;
};

export type VerifiedWorkspacePullRequestSource = VerifiedWorkspaceSource & {
  review: { repository: string; commit: string };
  projectBase?: { repository: string; branch: string };
  initial: boolean;
  reviewOnly: boolean;
  emptySource: boolean;
};

/** Prepare immutable source objects with the guest running and host custody retained. */
export async function prepareManagedWorkspaceSource(params: {
  owner: LocalWorkspaceOwner;
  identity: PreparedGitHubPublicationIdentity;
  target: { repository: string; baseBranch: string; githubHost: string };
  source?: VerifiedWorkspacePullRequestSource;
  verifiedBase?: VerifiedWorkspaceSource;
  conflictsResolved?: boolean;
  baseCommit?: string;
  assertCurrent: () => void;
  pristineError: string;
}) {
  const { owner, identity, target, assertCurrent, pristineError } = params;
  const integrationSource = params.source ?? params.verifiedBase;
  const initialImport = params.source?.initial === true;
  const action = params.source ? "prepare_pr" : "refresh_base";
  return await withLocalWorkspaceProjection(
    { ...owner, assertCurrent },
    async (state, quiescence) => {
      await state.settle();
      await quiescence?.resume();
      const check = () => {
        state.current();
      };
      const { run } = createGitHubPublicationCommandRunner(check);
      return await withWorktreeGitConfig(
        owner.worktree.path,
        true,
        { beforeRun: check },
        async (policy) => {
          const cwd = owner.worktree.path;
          const git = (args: string[]) => policy.require(cwd, args, { beforeRun: check });
          const probe = (args: string[]) => policy.run(cwd, args, { beforeRun: check });
          if (
            integrationSource &&
            (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])) !== owner.worktree.branch
          ) {
            throw new Error("The managed workspace branch changed; existing work was preserved.");
          }
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
              { contents: true, commitPresent, baseBranch: target.baseBranch },
            );
          await prepareContents(baseCommit, continuingIntegration);
          if (initialImport && !recoveredImport && !params.source!.emptySource) {
            const source = params.source!;
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
              { baseBranch: target.baseBranch },
            );
            const fromBase = await probe([
              "merge-base",
              "--is-ancestor",
              initialHead,
              source.review.commit,
            ]);
            const fromHead = await probe(["merge-base", "--is-ancestor", initialHead, baseCommit]);
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
                { baseBranch: source.projectBase.branch },
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
          check();
          return {
            baseCommit,
            initialHead,
            continuingIntegration,
            recoveredImport,
            previousBase: state.current().base_commit,
          };
        },
      );
    },
  );
}
