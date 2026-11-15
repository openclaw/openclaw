import fs from "node:fs/promises";
import { ok } from "@openclaw/normalization-core/result";
import { captureWorkspaceStateFilesystemGuard } from "../agents/workspace-state-guard.js";
import { requireGit } from "../agents/worktrees/git.js";
import { resolveRepositoryIdentity } from "../agents/worktrees/repository-paths.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-entry-children-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { deriveGitHubPublicationTaskId } from "../state/github-publication-requester.js";
import type { GitHubPublicationRequesterV2 } from "./github-publication-requester.js";
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
  const source = await fs.realpath(params.source);
  assertCurrent();
  const assertSource = captureWorkspaceStateFilesystemGuard(source, false);
  const assertPreparationCurrent = () => {
    assertCurrent();
    assertSource();
  };
  const origin = {
    agentId: parent.agentId,
    sessionKey: parent.canonicalKey,
    sessionId: parent.entry.sessionId,
    lifecycleRevision: parent.entry.lifecycleRevision ?? null,
  };
  const taskId = deriveGitHubPublicationTaskId(origin, params.idempotencyKey);
  const label = `github-publication-${taskId}`;
  const incognito = parent.entry.incognito === true || isIncognitoSessionKey(parent.canonicalKey);
  // Accepted retries recover the original source even if its task was renamed.
  const receipt = await readSharedGitHubPublication(origin, {
    idempotencyKey: params.idempotencyKey,
  });
  assertPreparationCurrent();
  let key = receipt?.session_key;
  if (!key && incognito) {
    const children = await listSessionChildEntriesReadOnly({
      agentId: parent.agentId,
      sessionKey: parent.canonicalKey,
      storePath: parent.storePath,
    });
    assertPreparationCurrent();
    key = children.find(({ entry }) => entry.label === label)?.sessionKey;
  }
  key ??= incognito ? undefined : `agent:${parent.agentId}:dashboard:github-${taskId}`;
  const assertTask = (entry: InternalSessionEntry | undefined) => {
    if (
      !entry ||
      entry.parentSessionKey !== origin.sessionKey ||
      entry.parentSessionId !== origin.sessionId ||
      (entry.parentSessionLifecycleRevision ?? null) !== origin.lifecycleRevision ||
      entry.createdVia !== "spawn" ||
      entry.projectId !== parent.entry.projectId ||
      (receipt && entry.sessionId !== receipt.session_id) ||
      entry.worktree?.canonicalWorkspaceDir !== source
    ) {
      throw new Error("The local publication task changed; its saved checkout was preserved.");
    }
  };
  if (key) {
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getConfig(),
      agentId: parent.agentId,
      key,
      assertActive: assertPreparationCurrent,
      projection: "full",
    });
    assertPreparationCurrent();
    if (loaded.entry) {
      assertTask(loaded.entry);
      return { agentId: parent.agentId, sessionKey: loaded.canonicalKey };
    }
    if (receipt) {
      throw new Error(
        "The original publication task is unavailable; inspect its existing receipt.",
      );
    }
  }
  const gitOptions = { signal: options.signal, beforeRun: assertPreparationCurrent };
  if (await requireGit(source, ["status", "--porcelain"], gitOptions)) {
    throw new Error("Commit the task changes before publishing this checkout.");
  }
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
