import { z } from "zod";
import {
  preparePersonalForgePublicationSource,
  withPersonalForgePublicationWorkspace,
  type PersonalForgePublicationActionV2,
} from "./forge-personal-publication-custody.js";
import {
  assertGitHubPublicationRefCasCompleted,
  recoverGitHubPublicationBranchAndIndex,
  updateGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";
import {
  assertSafeGitPublicationWorkspace,
  captureGitHubPublicationWorkspaceSnapshot,
  runPublicationCommand,
  requirePublicationCommand,
} from "./github-publication-git-transport.js";
import { insertPersonalGitLabPublicationAsync } from "./github-publication-request-async.js";
import {
  claimPersonalGitLabPublicationAsync,
  readPersonalGitLabPublicationAsync,
  type GitHubPublicationTransitionAuthority,
} from "./github-publication-store-async.js";
import {
  sameGitLabPublicationPublisher,
  type GitLabPublicationCredential,
} from "./gitlab-personal-publication-identity.js";
import { readSharedGitLabPublicationForAction } from "./gitlab-personal-publication-read.js";
import {
  createPersonalGitLabPublicationRow,
  readAcceptedGitLabPublication,
  gitLabPublicationReceiptSchema,
  type AcceptedGitLabPublication,
} from "./gitlab-personal-publication-row.js";
import type { PersonalGitLabPublicationRow } from "./gitlab-personal-publication-store.js";
import {
  createGitLabPublicationApi,
  type GitLabPublicationTarget,
} from "./gitlab-publication-adapter.js";
import {
  executeRepositoryGitLabPublication,
  type ForgePublicationExecution,
  type GitLabPublicationOutcome,
} from "./gitlab-publication-executor.js";
import { findGitLabPublicationMergeRequest } from "./gitlab-publication-merge-request.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

const oid = z.string().regex(/^[a-f0-9]{40}$/u);
export type AcceptedGitLabPublicationInput = {
  requestId: string;
  idempotencyKey: string;
  projectId: number;
  title: string;
  description?: string;
  draft?: boolean;
  bootstrapDraft?: boolean;
  baseBranch?: string;
};
export { gitLabPublicationReceiptSchema };
/** Reuse the native session/worktree reservation and accepted checkpoint, with GitLab as transport. */
export async function runPersonalGitLabPublication(
  options: Pick<GatewayRequestHandlerOptions, "context">,
  action: PersonalForgePublicationActionV2,
  credential: GitLabPublicationCredential,
  rawInput: AcceptedGitLabPublicationInput,
) {
  const input = {
    ...rawInput,
    description: rawInput.description ?? "",
    draft: rawInput.draft ?? true,
    bootstrapDraft: rawInput.bootstrapDraft ?? false,
  };
  if (input.bootstrapDraft && !input.draft) {
    throw new Error("An empty GitLab bootstrap publication must be a draft merge request.");
  }
  const config = options.context.getRuntimeConfig().gateway?.gitlab;
  if (!config || (config.projects && !config.projects.includes(input.projectId))) {
    throw new Error("GitLab publication project is not allowed.");
  }
  const placements = options.context.workerSessionPlacementService;
  if (!placements?.withLocalWorkspaceReservation || !placements.workspaceResultInstanceId) {
    throw new Error("Native local workspace custody is unavailable; retry after startup.");
  }
  const assertSelection = () => {
    action.assertCurrent();
    credential.assertCurrent();
    const current = options.context.getRuntimeConfig().gateway?.gitlab;
    if (!current || (current.projects && !current.projects.includes(input.projectId))) {
      throw new Error("GitLab project authority changed.");
    }
  };
  assertSelection();
  const existing =
    credential.publisher.source === "personal"
      ? await readPersonalGitLabPublicationAsync(action.owner, credential.account.issuer, {
          requestId: input.requestId,
        })
      : await readSharedGitLabPublicationForAction(action, credential.account.issuer, {
          requestId: input.requestId,
        });
  if (existing) {
    const accepted = readAcceptedGitLabPublication(existing);
    if (
      existing.idempotency_key !== input.idempotencyKey ||
      existing.connection_generation !== credential.generation ||
      !sameGitLabPublicationPublisher(accepted.publisher, credential.publisher) ||
      existing.identity_account_id !== credential.account.accountId ||
      existing.identity_login !== credential.account.login ||
      existing.session_id !== action.sessionId ||
      existing.session_key !== action.sessionKey ||
      existing.agent_id !== action.agentId ||
      existing.session_lifecycle_revision !== action.lifecycleRevision ||
      accepted.target.projectId !== input.projectId ||
      accepted.title !== input.title ||
      accepted.description !== input.description ||
      accepted.draft !== input.draft ||
      (accepted.bootstrapDraft ?? false) !== input.bootstrapDraft ||
      (input.baseBranch !== undefined && accepted.target.baseBranch !== input.baseBranch)
    ) {
      throw new Error("GitLab request belongs to a different account or accepted action.");
    }
  }
  if (
    existing?.status === "published" ||
    existing?.status === "failed" ||
    existing?.status === "publishing"
  ) {
    assertSelection();
    return existing;
  }
  const instanceId = placements.workspaceResultInstanceId();
  return withPersonalForgePublicationWorkspace(
    { withLocalWorkspaceReservation: placements.withLocalWorkspaceReservation },
    action,
    async (workspace) => {
      const { worktree } = workspace;
      const assertCurrent = () => {
        assertSelection();
        workspace.assertCurrent();
      };
      let row = existing;
      let saved!: AcceptedGitLabPublication;
      let native: Awaited<ReturnType<typeof claimPersonalGitLabPublicationAsync>> | undefined;
      try {
        assertCurrent();
        await assertSafeGitPublicationWorkspace(worktree.path, runPublicationCommand);
        if (
          (await requirePublicationCommand(["git", "symbolic-ref", "--short", "HEAD"], {
            cwd: worktree.path,
            beforeRun: assertCurrent,
          })) !== worktree.branch
        ) {
          throw new Error("The managed worktree branch changed.");
        }
        const selectedTarget: GitLabPublicationTarget = {
          issuer: credential.account.issuer,
          projectId: input.projectId,
          projectPath: "",
          gitUrl: "",
          webUrl: "",
          baseBranch: "",
        };
        const api = createGitLabPublicationApi({
          target: selectedTarget,
          credentials: credential,
          assertCurrent,
        });
        const project = z
          .object({
            id: z.number(),
            path_with_namespace: z.string(),
            http_url_to_repo: z.string(),
            web_url: z.string(),
            default_branch: z.string(),
          })
          .parse(await api.request({ method: "GET", path: `projects/${input.projectId}` }));
        if (
          project.id !== input.projectId ||
          !/^[\w.-]+(?:\/[\w.-]+)+$/u.test(project.path_with_namespace) ||
          project.http_url_to_repo !==
            `${credential.account.issuer}/${project.path_with_namespace}.git` ||
          project.web_url !== `${credential.account.issuer}/${project.path_with_namespace}`
        ) {
          throw new Error("GitLab canonical project identity is invalid.");
        }
        const target = {
          ...selectedTarget,
          projectPath: project.path_with_namespace,
          gitUrl: project.http_url_to_repo,
          webUrl: project.web_url,
          baseBranch: input.baseBranch ?? project.default_branch,
        };
        await requirePublicationCommand(
          ["git", "check-ref-format", `refs/heads/${target.baseBranch}`],
          {
            cwd: worktree.path,
            beforeRun: assertCurrent,
          },
        );
        const remote = await requirePublicationCommand(["git", "remote", "get-url", "origin"], {
          cwd: worktree.path,
          beforeRun: assertCurrent,
        });
        if (remote !== target.gitUrl) {
          throw new Error("Session repository does not match the canonical GitLab project.");
        }
        if (row) {
          saved = readAcceptedGitLabPublication(row);
          if (
            saved.worktreeId !== worktree.id ||
            saved.repositoryRoot !== worktree.path ||
            saved.repositoryFingerprint !== worktree.repoFingerprint ||
            saved.branch !== worktree.branch ||
            JSON.stringify(saved.target) !== JSON.stringify(target)
          ) {
            throw new Error("Accepted GitLab publication target or workspace changed.");
          }
        } else {
          const captured = await captureGitHubPublicationWorkspaceSnapshot({
            cwd: worktree.path,
            assertCurrent,
          });
          const baseTree = oid.parse(
            await requirePublicationCommand(
              ["git", "rev-parse", `${captured.sourceHeadCommit}^{tree}`],
              { cwd: worktree.path, beforeRun: assertCurrent },
            ),
          );
          if (input.bootstrapDraft && captured.workspaceTree !== baseTree) {
            throw new Error("An empty GitLab bootstrap publication requires an unchanged tree.");
          }
          let previousHeadCommit: string | null = null;
          try {
            const branch = z.object({ commit: z.object({ id: oid }) }).parse(
              await api.request({
                method: "GET",
                path: `projects/${target.projectId}/repository/branches/${encodeURIComponent(worktree.branch)}`,
              }),
            );
            previousHeadCommit = branch.commit.id;
          } catch (error) {
            if (!(error instanceof Error) || !error.message.endsWith("HTTP 404.")) {
              throw error;
            }
          }
          if (input.bootstrapDraft && previousHeadCommit !== null) {
            throw new Error(
              "An empty GitLab bootstrap publication requires an unpublished branch.",
            );
          }
          const publicationParentCommit =
            previousHeadCommit ??
            z
              .object({
                name: z.literal(target.baseBranch),
                commit: z.object({ id: oid }),
              })
              .parse(
                await api.request({
                  method: "GET",
                  path: `projects/${target.projectId}/repository/branches/${encodeURIComponent(target.baseBranch)}`,
                }),
              ).commit.id;
          // Local task commits may be unpublished. Preserve the remote history and
          // publish their accepted tree under the connected user's verified credit.
          await requirePublicationCommand(
            [
              "git",
              "merge-base",
              "--is-ancestor",
              publicationParentCommit,
              captured.sourceHeadCommit,
            ],
            { cwd: worktree.path, beforeRun: assertCurrent },
          );
          if (
            input.bootstrapDraft &&
            captured.workspaceTree !==
              (await requirePublicationCommand(
                ["git", "rev-parse", `${publicationParentCommit}^{tree}`],
                { cwd: worktree.path, beforeRun: assertCurrent },
              ))
          ) {
            throw new Error(
              "An empty GitLab bootstrap publication requires an unchanged remote base tree.",
            );
          }
          saved = {
            target,
            sessionIdentity: {
              sessionId: action.sessionId,
              sessionKey: action.sessionKey,
              agentId: action.agentId,
              lifecycleRevision: action.lifecycleRevision,
            },
            sourceId: worktree.id,
            worktreeId: worktree.id,
            repositoryRoot: worktree.path,
            repositoryFingerprint: worktree.repoFingerprint,
            actor: { accountId: credential.account.accountId, login: credential.account.login },
            publisher: credential.publisher,
            title: input.title,
            description: input.description ?? "",
            draft: input.draft ?? true,
            bootstrapDraft: input.bootstrapDraft,
            sourceHead: captured.sourceHeadCommit,
            baseTree,
            workspaceHead: captured.workspaceTree,
            sourceIndexTree: captured.sourceIndexTree,
            branch: worktree.branch,
            createdAtMs: Date.now(),
            previousHeadCommit,
            publicationParentCommit,
          };
          const pending = createPersonalGitLabPublicationRow({
            action,
            credential,
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            saved,
          });
          const source = await preparePersonalForgePublicationSource(
            action,
            {
              agentId: action.agentId,
              sessionKey: action.sessionKey,
              sessionId: action.sessionId,
              lifecycleRevision: action.lifecycleRevision,
              worktreeId: worktree.id,
            },
            assertCurrent,
          );
          row = await insertPersonalGitLabPublicationAsync(pending, source);
          if (row.status !== "requested") {
            throw new Error(
              "GitLab publication was already accepted; recover the original request.",
            );
          }
          saved = readAcceptedGitLabPublication(row);
        }
        if (!row) {
          throw new Error("Native GitLab publication receipt is unavailable.");
        }
        let recoveredMr: Awaited<ReturnType<typeof findGitLabPublicationMergeRequest>>;
        let pushObservation: "applied" | "unchanged" | undefined;
        if (row.status === "needs_confirmation") {
          // Read-only observation precedes a new execution lease. An unobserved MR
          // dispatch never authorizes another POST, even if its branch is current.
          let observedHead: string | null = null;
          try {
            observedHead = z.object({ commit: z.object({ id: oid }) }).parse(
              await api.request({
                method: "GET",
                path: `projects/${target.projectId}/repository/branches/${encodeURIComponent(saved.branch)}`,
              }),
            ).commit.id;
          } catch (error) {
            if (!(error instanceof Error) || !error.message.endsWith("HTTP 404.")) {
              throw error;
            }
          }
          if (row.head_commit) {
            if (
              observedHead !== row.head_commit &&
              (row.last_effect !== "push" || observedHead !== saved.previousHeadCommit)
            ) {
              throw new Error(
                "The original GitLab push is still unconfirmed; preserve this request and inspect its branch.",
              );
            }
            if (observedHead === row.head_commit) {
              recoveredMr = await findGitLabPublicationMergeRequest({
                api,
                target,
                branch: saved.branch,
                headCommit: row.head_commit,
                previousHeadCommit: saved.previousHeadCommit,
                accountId: credential.account.accountId,
                requestId: input.requestId,
              });
            }
            if (!recoveredMr && row.last_effect !== "push") {
              throw new Error(
                "The original merge request creation is still unconfirmed; do not repeat it.",
              );
            }
            if (!recoveredMr) {
              pushObservation = observedHead === row.head_commit ? "applied" : "unchanged";
            }
          } else if (row.last_effect !== null) {
            throw new Error("The original GitLab publication effect is unconfirmed.");
          }
        }
        const authority: GitHubPublicationTransitionAuthority = {
          assertAction: assertCurrent,
          assertCustody: assertCurrent,
          prepareSource: () =>
            preparePersonalForgePublicationSource(
              action,
              {
                agentId: row!.agent_id,
                sessionKey: row!.session_key,
                sessionId: row!.session_id,
                lifecycleRevision: row!.session_lifecycle_revision,
                worktreeId: row!.worktree_id,
              },
              assertCurrent,
            ),
        };
        native = await claimPersonalGitLabPublicationAsync(row, instanceId, authority);
        row = native.row;
        if (recoveredMr) {
          const result: GitLabPublicationOutcome = {
            status: "published",
            requestId: input.requestId,
            url: recoveredMr.webUrl,
            repository: target.projectPath,
            branch: saved.branch,
            headCommit: row.head_commit!,
            publisherAccountId: credential.account.accountId,
            mergeRequestAuthorId: recoveredMr.authorId,
          };
          row = await native.complete(
            result,
            JSON.stringify({
              ...result,
              actor: credential.account,
              sourceHeadCommit: saved.sourceHead,
              finalHeadCommit: row.head_commit,
              projectId: target.projectId,
              reconciled: true,
            }),
          );
          assertCurrent();
          return row;
        }
        if (pushObservation) {
          row = await native.recordEffect(
            "push",
            pushObservation === "applied" ? { headCommit: row.head_commit! } : undefined,
            pushObservation,
          );
        }
        await recoverGitHubPublicationBranchAndIndex({
          cwd: worktree.path,
          requestId: input.requestId,
          branch: saved.branch,
          sourceHeadCommit: saved.sourceHead,
          workspaceTree: saved.workspaceHead,
          assertCustody: assertCurrent,
          run: requirePublicationCommand,
        });
        const snapshot = {
          baseCommit: saved.sourceHead,
          baseTree: saved.baseTree,
          workspaceTree: saved.workspaceHead,
        };
        await requirePublicationCommand(
          ["git", "cat-file", "-e", `${saved.workspaceHead}^{tree}`],
          { cwd: worktree.path, beforeRun: assertCurrent },
        );
        const captured = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: worktree.path,
          assertCurrent,
        });
        if (
          (captured.sourceHeadCommit !== saved.sourceHead &&
            captured.sourceHeadCommit !== row.head_commit) ||
          (captured.sourceIndexTree !== saved.sourceIndexTree &&
            captured.sourceIndexTree !== saved.workspaceHead) ||
          captured.workspaceTree !== saved.workspaceHead
        ) {
          throw new Error(
            "Accepted workspace changed; preserve it and start a new publication request.",
          );
        }
        const execution: ForgePublicationExecution<PersonalGitLabPublicationRow> = {
          row: {
            requestId: input.requestId,
            branch: saved.branch,
            createdAtMs: saved.createdAtMs,
            sourceHeadCommit: saved.sourceHead,
            sourceIndexTree: saved.baseTree,
            workspaceTree: saved.workspaceHead,
            previousHeadCommit: saved.previousHeadCommit,
            headCommit: row.head_commit,
            // SAFETY: The native publication table CHECK constrains last_effect to these values or NULL.
            lastEffect: row.last_effect as "push" | "pull_request" | null,
            // SAFETY: The native publication table CHECK constrains effect_state to these values or NULL.
            effectState: row.effect_state as "dispatched" | "observed" | null,
          },
          ownsExecution: () => native!.ownsExecution(),
          updateHead: async (headCommit) => {
            row = await native!.updateHead(headCommit);
          },
          recordEffect: async (effect, observed) => {
            row = await native!.recordEffect(effect, observed);
          },
          complete: async (result: GitLabPublicationOutcome) => {
            const provenance = {
              ...result,
              actor: credential.account,
              sourceHeadCommit: saved.sourceHead,
              finalHeadCommit: row!.head_commit,
              projectId: target.projectId,
            };
            row = await native!.complete(result, JSON.stringify(provenance));
            return row;
          },
          interrupt: async () => {
            row = await native!.interrupt();
            return row;
          },
        };
        return await executeRepositoryGitLabPublication({
          execution,
          snapshot,
          repositoryRoot: worktree.path,
          target,
          identity: credential.account,
          credentials: credential,
          assertCurrent,
          commitLocally: async ({ headCommit, directory }) => {
            assertCurrent();
            // Import exactly the locally prepared object; no remote or credential is involved.
            await requirePublicationCommand(
              [
                "git",
                "fetch",
                "--no-auto-maintenance",
                "--no-tags",
                "--no-write-fetch-head",
                "--recurse-submodules=no",
                "--",
                directory,
                headCommit,
              ],
              { cwd: worktree.path, beforeRun: assertCurrent },
            );
            const head = await requirePublicationCommand(["git", "rev-parse", "HEAD"], {
              cwd: worktree.path,
              beforeRun: assertCurrent,
            });
            if (head === headCommit) {
              return;
            }
            if (head !== saved.sourceHead) {
              throw new Error("Local publication source changed before its commit.");
            }
            await updateGitHubPublicationBranchAndIndex({
              cwd: worktree.path,
              requestId: input.requestId,
              branch: saved.branch,
              previousHead: saved.sourceHead,
              sourceIndexTree: saved.sourceIndexTree,
              workspaceTree: saved.workspaceHead,
              headCommit,
              env: {},
              assertCurrent,
              assertCustody: assertCurrent,
              run: requirePublicationCommand,
              updateRef: async () => {
                const updated = await runPublicationCommand(
                  ["git", "update-ref", `refs/heads/${saved.branch}`, headCommit, saved.sourceHead],
                  { cwd: worktree.path, beforeRun: assertCurrent },
                );
                assertGitHubPublicationRefCasCompleted(updated);
              },
            });
          },
          assertWorkflowChangesAllowed: assertCurrent,
          title: saved.title,
          description: saved.description,
          draft: saved.draft,
          bootstrapDraft: saved.bootstrapDraft ?? false,
          parentCommit: saved.publicationParentCommit,
        });
      } catch (error) {
        if (native && row?.status === "publishing") {
          try {
            row = await native.interrupt();
          } catch {
            // The durable effect and execution lease remain available for recovery.
          }
        }
        throw error;
      }
    },
  );
}
