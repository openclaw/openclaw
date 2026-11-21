import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { ok } from "@openclaw/normalization-core/result";
import {
  captureWorkspaceFilesystemEvidence,
  createWorkspaceFilesystemSource,
  validateWorkspaceFilesystemEvidence,
} from "../agents/workspace-state-guard.js";
import { commandError, requireGit, runGit } from "../agents/worktrees/git.js";
import { resolveRepositoryIdentity } from "../agents/worktrees/repository-paths.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-entry-children-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  prepareGitHubPublicationTaskRequester,
  type GitHubPublicationRequesterV2,
} from "./github-publication-requester.js";
import type { PublicationSessionRead } from "./github-publication-session.types.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { resolveRequesterProject } from "./project-access.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createGatewaySession } from "./session-create-service.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";

/** Local publication owns a task checkout, never the initiating conversation's workspace. */
export async function prepareGitHubPublicationTaskWorkspace(params: {
  options: GatewayRequestHandlerOptions;
  parent: PublicationSessionRead & { entry: InternalSessionEntry };
  requester: GitHubPublicationRequesterV2;
  source: string;
  idempotencyKey: string;
  policy?: {
    allow: string[];
    deny: string[];
    permissionMode?: InternalSessionEntry["permissionMode"];
  };
  assertCurrent: () => void;
}) {
  const { options, parent, requester } = params;
  const getConfig = options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig;
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    requester.assertCurrent();
    params.assertCurrent();
  };
  assertCurrent();
  const filesystem = await captureWorkspaceFilesystemEvidence(params.source);
  if (!filesystem.root[1]) {
    throw new Error("The publication source is unavailable; restore the checkout before retrying.");
  }
  const source = filesystem.canonical;
  const assertPreparationCurrent = createWorkspaceFilesystemSource(filesystem, assertCurrent);
  assertPreparationCurrent();
  const origin = {
    agentId: parent.agentId,
    sessionKey: parent.canonicalKey,
    sessionId: parent.entry.sessionId,
    lifecycleRevision: parent.entry.lifecycleRevision ?? null,
  };
  // One task owns each checkout's publication for this conversation, so later
  // publications from the checkout update the same branch and PR.
  const hash = createHash("sha256").update(`${origin.sessionKey}\0${source}`).digest("hex");
  const label = `github-publication-${hash.slice(0, 32)}`;
  const incognito = parent.entry.incognito === true || isIncognitoSessionKey(parent.canonicalKey);
  // Accepted retries retain their original task, including renamed and older tasks.
  const receipt = await readSharedGitHubPublication(origin, {
    idempotencyKey: params.idempotencyKey,
  });
  assertPreparationCurrent();
  let key =
    receipt?.session_key ?? (incognito ? undefined : `agent:${parent.agentId}:dashboard:${label}`);
  const assertTask = (entry: InternalSessionEntry | undefined) => {
    if (
      !entry ||
      entry.parentSessionKey !== origin.sessionKey ||
      entry.createdVia !== "spawn" ||
      entry.projectId !== parent.entry.projectId ||
      (receipt && entry.sessionId !== receipt.session_id) ||
      entry.worktree?.canonicalWorkspaceDir !== source
    ) {
      throw new Error("The local publication task changed; its saved checkout was preserved.");
    }
  };
  let existing = key
    ? await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getConfig(),
        agentId: parent.agentId,
        key,
        assertActive: assertPreparationCurrent,
        projection: "full",
      })
    : undefined;
  assertPreparationCurrent();
  // A retry must not republish an accepted request whose task was deleted.
  if (receipt && !existing?.entry) {
    throw new Error("The original publication task is unavailable; inspect its existing receipt.");
  }
  if (!existing?.entry) {
    // Earlier versions keyed tasks by invocation. Reuse their recorded checkout
    // custody instead of opening another PR after an upgrade.
    const children = await listSessionChildEntriesReadOnly({
      agentId: parent.agentId,
      sessionKey: parent.canonicalKey,
      storePath: parent.storePath,
    });
    assertPreparationCurrent();
    const matches = children.filter(
      ({ entry }) =>
        entry.createdVia === "spawn" &&
        entry.label?.startsWith("github-publication-") &&
        entry.worktree?.canonicalWorkspaceDir === source,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple publication tasks already use this checkout: ${matches.map((child) => child.sessionKey).join(", ")}. Inspect each with github_publish(action: "readiness", publishingSessionKey: <task key>), then continue in the intended task session. No new PR was created.`,
      );
    }
    if (matches[0]) {
      key = matches[0].sessionKey;
      existing = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getConfig(),
        agentId: parent.agentId,
        key,
        assertActive: assertPreparationCurrent,
        projection: "full",
      });
      assertPreparationCurrent();
      assertTask(existing.entry);
    }
  }
  const gitOptions = { signal: options.signal, beforeRun: assertPreparationCurrent };
  if (parent.entry.projectId) {
    const project = await resolveRequesterProject(
      getConfig(),
      parent.entry.projectId,
      { kind: "operator", scopes: requester.snapshot.scopes },
      { fresh: true },
    );
    const [projectRoot, repository] = await Promise.all([
      project ? fs.realpath(project.repoRoot).catch(() => undefined) : undefined,
      resolveRepositoryIdentity(source),
    ]);
    assertPreparationCurrent();
    if (!projectRoot) {
      throw new Error(
        "This conversation's project is unavailable to this requester; its files were preserved.",
      );
    }
    if (repository.repoRoot !== projectRoot) {
      throw new Error(
        "This checkout belongs to a different repository than the conversation's project; its files were preserved.",
      );
    }
  }
  if (existing?.entry) {
    assertTask(existing.entry);
    if (receipt) {
      await validateWorkspaceFilesystemEvidence(filesystem);
      assertPreparationCurrent();
      return { agentId: parent.agentId, sessionKey: existing.canonicalKey };
    }
  }
  if (await requireGit(source, ["status", "--porcelain"], gitOptions)) {
    throw new Error("Commit the task changes before publishing this checkout.");
  }
  if (existing?.entry) {
    // Access to the conversation does not imply access to a task created by
    // another requester. Authorize its mutation before synchronizing the checkout.
    const prepared = await prepareGitHubPublicationTaskRequester(
      requester,
      { agentId: parent.agentId, sessionKey: existing.canonicalKey },
      origin,
      getConfig,
    );
    using _ = { [Symbol.dispose]: prepared.release };
    gitOptions.beforeRun = createWorkspaceFilesystemSource(filesystem, () => {
      assertCurrent();
      prepared.requester.assertCurrent();
    });
    // Merge the source commit with its exact tree: the task branch fast-forwards and
    // its PR shows the source's changes even after a rebase or amend.
    const cwd = existing.entry.spawnedCwd!;
    const format = "--format=%H%n%T%n%an%n%ae%n%cn%n%ce";
    const [head, tree, an, ae, cn, ce] = (
      await requireGit(source, ["log", "-1", format], gitOptions)
    ).split("\n");
    const ancestry = await runGit(cwd, ["merge-base", "--is-ancestor", head!, "HEAD"], gitOptions);
    if (ancestry.termination !== "exit" || (ancestry.code !== 0 && ancestry.code !== 1)) {
      throw commandError("git merge-base --is-ancestor", ancestry);
    }
    // A rebase can change ancestry without changing a single file. Retain that
    // ancestry too, so GitHub's merge-base diff excludes changes already upstream.
    if (
      ancestry.code === 1 ||
      tree !== (await requireGit(cwd, ["rev-parse", "HEAD^{tree}"], gitOptions))
    ) {
      const env = {
        GIT_AUTHOR_NAME: an,
        GIT_AUTHOR_EMAIL: ae,
        GIT_COMMITTER_NAME: cn,
        GIT_COMMITTER_EMAIL: ce,
      };
      const merge = await requireGit(
        cwd,
        ["commit-tree", "--no-gpg-sign", "-p", "HEAD", "-p", head!, "-m", `Merge ${head}`, tree!],
        { ...gitOptions, env },
      );
      await requireGit(cwd, ["merge", "--ff-only", "--quiet", merge], gitOptions);
    }
    return { agentId: parent.agentId, sessionKey: existing.canonicalKey };
  }
  const checkoutCommit = await requireGit(source, ["rev-parse", "HEAD"], gitOptions);
  const captured = await captureGatewayOperatorRunAuthority(options);
  using _ = { [Symbol.dispose]: () => captured?.release() };
  assertPreparationCurrent();
  const actor = requester.snapshot.actor;
  const permissionMode = params.policy?.permissionMode ?? parent.entry.permissionMode;
  const created = await createGatewaySession({
    cfg: getConfig(),
    getCurrentConfig: getConfig,
    operatorAuthority: Promise.resolve(captured),
    key,
    agentId: parent.agentId,
    parentSessionKey: parent.canonicalKey,
    projectId: parent.entry.projectId,
    label,
    displayName: "GitHub publication",
    requestingOperatorScopes: requester.snapshot.scopes,
    requestingOperatorProfileId: actor.kind === "operator" ? actor.profileId : undefined,
    operatorRoleActor: actor,
    creation: {
      via: "spawn",
      actor: {
        type: "agent",
        id: parent.agentId,
        ...(actor.kind === "operator"
          ? {
              delegatedBy: {
                type: "human" as const,
                source: "profile" as const,
                id: actor.profileId,
              },
            }
          : {}),
      },
      requesterProfileId: actor.kind === "operator" ? actor.profileId : undefined,
    },
    spawnDepth: (parent.entry.spawnDepth ?? 0) + 1,
    spawnToolPolicy: {
      version: 1,
      allow: params.policy?.allow ?? parent.entry.inheritedToolAllow ?? [],
      deny: params.policy?.deny ?? parent.entry.inheritedToolDeny ?? [],
      delegatedToolPolicy: parent.entry.delegatedToolPolicy,
    },
    ...(permissionMode
      ? {
          preparedPermissionSelection: {
            mode: permissionMode,
            assertCurrent: assertPreparationCurrent,
          },
        }
      : {}),
    commandSource: "github-publication",
    commitGuard: assertPreparationCurrent,
    prepareLifecycle: async (target) => {
      if (target.entry) {
        assertTask(target.entry);
        return ok({});
      }
      return await prepareSessionWorktree({
        cfg: getConfig(),
        target,
        workspace: source,
        // Separate checkouts can share a remote; scope the branch to this publication task.
        label,
        checkoutCommit,
        runSetupScript: false,
        signal: options.signal,
        commitGuard: assertPreparationCurrent,
      });
    },
  });
  assertPreparationCurrent();
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  if (created.postCommit.status === "failed") {
    throw created.postCommit.error;
  }
  assertTask(created.entry);
  return { agentId: parent.agentId, sessionKey: created.key };
}
