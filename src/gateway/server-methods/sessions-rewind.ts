import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateSessionsBranchesListParams,
  validateSessionsBranchesSwitchParams,
  validateSessionsForkParams,
  validateSessionsRewindParams,
  type SessionsBranchesListParams,
  type SessionsBranchesSwitchParams,
  type SessionsRewindParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ErrorCode } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { clearSessionLifecycleQueues } from "../../auto-reply/reply/queue/cleanup.js";
import {
  listSessionBranches,
  type SessionBranchSwitchMutationResult,
  type SessionMessageCutMutationResult,
} from "../../config/sessions/session-accessor.js";
import { mutateSessionAtMessageWithPreconditions } from "../../config/sessions/session-accessor.sqlite-message-cut.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
  withSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import { MEDIA_MAX_BYTES, readMediaBuffer } from "../../media/store.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import { recordSessionCreated } from "../../sessions/session-created.js";
import { withSessionInitializationSource } from "../../sessions/session-initialization.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  captureSessionUpstreamLinkReadSource,
  prepareSessionUpstreamLink,
  readCurrentSessionUpstreamLink,
} from "../../sessions/session-upstream-links-runtime.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { buildDashboardSessionKey } from "../session-create-key.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { withPreparedSessionEventRow } from "../session-event-prepared-row.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { withGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import type { loadGatewaySessionEntryReadOnly } from "../session-utils-store.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { resolveSessionWorkerPlacementMutationError } from "../worker-environments/session-placement-lifecycle.js";
import { forkSessionRepositoryWorkspace } from "../worker-environments/session-repository-checkpoints.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { prepareSessionForkFilesystemRoot } from "./session-create-root.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { waitForTerminalSessionRunSettlement } from "./session-run-settlement.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import {
  createUpstreamForkCurrentGuard,
  resolveUpstreamForkHarness,
} from "./sessions-fork-runtime-guard.js";
import { loadAccessorSessionEntryForGatewayTarget, sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

type MessageCutAction = "fork" | "rewind" | "switch";
type MessageCutMutationResult =
  | SessionMessageCutMutationResult
  | SessionBranchSwitchMutationResult
  | { status: "conflict" };

const EXTERNAL_CONVERSATION_ERROR =
  "Session history changes are unavailable because this session is owned by an external agent harness.";

// A message realistically carries a handful of images; a corrupt transcript must
// not turn rewind into a bulk media read.
const EDITOR_MEDIA_REF_LIMIT = 10;

async function resolveEditorMediaAttachments(
  refs: Array<{ path: string; contentType: string }> | undefined,
): Promise<Array<{ mimeType: string; data: string }>> {
  if (!refs) {
    return [];
  }
  const seen = new Set<string>();
  const attachments: Array<{ mimeType: string; data: string }> = [];
  for (const ref of refs) {
    // Transcript references are untrusted hints; only an inbound id is read through the
    // media store (its traversal guards and byte cap stay authoritative), so
    // dedupe on that resolved id — path aliases must not repeat the same read.
    let id: string;
    try {
      id = parseInboundMediaUri(ref.path)?.id ?? path.basename(ref.path);
    } catch {
      // A corrupt URI is only a failed attachment hint, never a failed history cut.
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (seen.size > EDITOR_MEDIA_REF_LIMIT) {
      break;
    }
    try {
      const media = await readMediaBuffer(id, "inbound", MEDIA_MAX_BYTES);
      attachments.push({ mimeType: ref.contentType, data: media.buffer.toString("base64") });
    } catch {
      // Skipped refs (missing file, oversized, guard rejection) never fail the cut.
    }
  }
  return attachments;
}

export const sessionRewindHandlers: GatewayRequestHandlers = {
  "sessions.branches.list": defineValidatedGatewayHandler(
    "sessions.branches.list",
    validateSessionsBranchesListParams,
    listBranches,
  ),
  "sessions.branches.switch": defineValidatedGatewayHandler(
    "sessions.branches.switch",
    validateSessionsBranchesSwitchParams,
    (options) => mutateSessionAtMessage(options, "switch"),
  ),
  "sessions.rewind": defineValidatedGatewayHandler(
    "sessions.rewind",
    validateSessionsRewindParams,
    (options) => mutateSessionAtMessage(options, "rewind"),
  ),
  "sessions.fork": defineValidatedGatewayHandler(
    "sessions.fork",
    validateSessionsForkParams,
    (options) => mutateSessionAtMessage(options, "fork"),
  ),
};

async function listBranches(
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: SessionsBranchesListParams },
): Promise<void> {
  const { params, respond, context } = options;
  const sessionKey = params.sessionKey.trim();
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  // Branches depend on transcript/lifecycle state, not a label or activity update during I/O.
  const read = retainSessionScopedRead(options, sessionKey, requestedAgent.agentId, {
    allowMetadataChanges: true,
  });
  const run = () =>
    withGatewaySessionEntryReadOnly(
      {
        key: sessionKey,
        cfg,
        agentId: requestedAgent.agentId,
        excludeInternalEffects: true,
        projection: "list",
      },
      async (current, assertCurrent) => {
        const upstreamLink = current.entry?.sessionId
          ? await prepareSessionUpstreamLink(
              captureSessionUpstreamLinkReadSource(),
              current.canonicalKey,
              current.agentId,
            )
          : undefined;
        assertCurrent();
        read?.assertCurrent();
        if (!current.entry?.sessionId || upstreamLink) {
          // Fresh and upstream-owned sessions have no local branches. Only the
          // mutating siblings treat those states as errors.
          respond(true, { branches: [] }, undefined);
          return;
        }
        const memory = getSessionActorStorageBinding({
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          storePath: current.storePath,
        });
        const result = memory
          ? await memory.actor.storage!.read(
              { type: "session.history.branches", input: {} },
              memory.authority,
            )
          : await listSessionBranches({
              agentId: current.agentId,
              sessionKey: current.canonicalKey,
              sessionStoreKey: current.canonicalKey,
              storePath: current.storePath,
            });
        assertCurrent();
        read?.assertCurrent();
        if (result.status !== "ok") {
          respond(
            false,
            undefined,
            errorShape(
              result.status === "failed" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
              {
                "missing-session": "session not found",
                "unsupported-storage": "session transcript storage does not support branch listing",
                failed: "failed to list session branches",
              }[result.status],
            ),
          );
          return;
        }
        respond(true, { branches: result.branches }, undefined);
      },
    );
  const assertCurrent = () => read?.assertCurrent();
  try {
    const handled = await withSessionActorStorage(
      { sessionKey, agentId: requestedAgent.agentId },
      {
        lifetime: { assertCurrent, assertReadable: assertCurrent },
        authority: { assertCurrent, authorize() {} },
      },
      async () => {
        await run();
        return true;
      },
    );
    if (!handled) {
      await run();
    }
  } finally {
    read?.release();
  }
}

async function mutateSessionAtMessage(
  options: Omit<GatewayRequestHandlerOptions, "params"> & {
    params: SessionsBranchesSwitchParams | SessionsRewindParams;
  },
  action: MessageCutAction,
): Promise<void> {
  const { params, respond, context } = options;
  const sessionKey = params.sessionKey.trim();
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const run = () =>
    withGatewaySessionEntryReadOnly(
      { key: sessionKey, cfg, agentId: requestedAgent.agentId, excludeInternalEffects: true },
      async (initial, assertSourceCurrent) =>
        mutatePreparedSessionAtMessage({
          options,
          action,
          cfg,
          requestedAgentId: requestedAgent.agentId,
          initial,
          assertSourceCurrent,
        }),
    );
  const assertCurrent = () => {
    options.sessionMutationCommitGuard?.();
    options.sessionMutationAuthorization?.assertCurrent();
  };
  const handled = await withSessionActorStorage(
    { sessionKey, agentId: requestedAgent.agentId },
    {
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      authority: { assertCurrent, authorize() {} },
    },
    async () => {
      await run();
      return true;
    },
  );
  if (!handled) {
    await run();
  }
}

async function mutatePreparedSessionAtMessage({
  options,
  action,
  cfg,
  requestedAgentId,
  initial,
  assertSourceCurrent,
}: {
  options: Parameters<typeof mutateSessionAtMessage>[0];
  action: MessageCutAction;
  cfg: OpenClawConfig;
  requestedAgentId: string;
  initial: ReturnType<typeof loadGatewaySessionEntryReadOnly>;
  assertSourceCurrent: () => void;
}): Promise<void> {
  const { params, respond, context, client } = options;
  const memory = getSessionActorStorageBinding({
    sessionKey: initial.canonicalKey,
    agentId: initial.agentId,
    storePath: initial.storePath,
  });
  const reject = (message: string, code: ErrorCode = ErrorCodes.INVALID_REQUEST) =>
    respond(false, undefined, errorShape(code, message));
  const { sessionMutationCommitGuard, sessionMutationAuthorization } = options;
  const commitGuard = () => {
    sessionMutationCommitGuard?.();
    sessionMutationAuthorization?.assertCurrent();
  };
  const sessionKey = params.sessionKey.trim();
  const entryId = ("leafEntryId" in params ? params.leafEntryId : params.entryId).trim();
  const loadCurrent = () =>
    withGatewaySessionEntryReadOnly(
      { key: sessionKey, cfg, agentId: requestedAgentId, excludeInternalEffects: true },
      async (current) => {
        assertSourceCurrent();
        commitGuard();
        return current;
      },
    );
  if (!initial.entry?.sessionId) {
    reject(`session not found: ${sessionKey}`);
    return;
  }
  const rejectInitializing = (pending: boolean | undefined) => {
    if (!pending) {
      return false;
    }
    reject(`Session ${sessionKey} is initializing; retry ${action} later.`, ErrorCodes.UNAVAILABLE);
    return true;
  };
  if (rejectInitializing(initial.entry.initializationPending)) {
    return;
  }
  if (action === "fork") {
    const creationError = authorizeGatewaySessionCreation({
      cfg,
      client,
      agentId: initial.agentId,
    });
    if (creationError) {
      respond(false, undefined, creationError);
      return;
    }
  }
  const assertMutationCurrent = () => {
    assertSourceCurrent();
    commitGuard();
  };
  const initialSessionId = initial.entry.sessionId;
  const initialLifecycleRevision = initial.entry.lifecycleRevision;
  const upstreamContext = captureSessionUpstreamLinkReadSource();
  const upstreamLink =
    action === "fork"
      ? await prepareSessionUpstreamLink(upstreamContext, initial.canonicalKey, initial.agentId)
      : undefined;
  assertMutationCurrent();

  const lifecycleIdentities = [
    sessionKey,
    initial.canonicalKey,
    initialSessionId,
    initialLifecycleRevision,
  ];
  const terminalSettled = await waitForTerminalSessionRunSettlement({
    context,
    storePath: initial.storePath,
    requestedKey: sessionKey,
    canonicalKey: initial.canonicalKey,
    sessionId: initialSessionId,
    agentId: requestedAgentId,
    defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey),
    signal: options.signal,
  });
  let blockedByActiveRun = false;
  await runExclusiveSessionLifecycleMutation(action, {
    scope: initial.storePath,
    identities: lifecycleIdentities,
    prepare: async () => {
      const current = await loadCurrent();
      // A message cut cannot disturb its source or invalidate queued work on failure.
      // Reject live work before transcript mutation instead of interrupting it.
      blockedByActiveRun =
        !terminalSettled ||
        isCompetingSessionWorkAdmissionActive(initial.storePath, lifecycleIdentities) ||
        (getWorkerInferenceSessionControl(context.workerEnvironmentService)?.hasSession(
          initialSessionId,
        ) ??
          false) ||
        resolveVisibleActiveSessionRunState({
          context,
          requestedKey: sessionKey,
          canonicalKey: current.canonicalKey,
          sessionId: initialSessionId,
          agentId: requestedAgentId,
          defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey),
        }).active;
    },
    run: async () => {
      // A queued sharing mutation can revoke participation without rotating the source identity.
      // Revalidate under the shared lifecycle fence before delegating or writing history.
      assertMutationCurrent();
      if (blockedByActiveRun) {
        reject(
          action === "switch"
            ? "Branch switch is unavailable while the agent is working."
            : `${action === "fork" ? "Fork" : "Rewind"} is unavailable while the agent is working.`,
          ErrorCodes.UNAVAILABLE,
        );
        return;
      }
      const current = await loadCurrent();
      if (
        !current.entry ||
        (!memory &&
          (current.entry?.sessionId !== initialSessionId ||
            current.entry.lifecycleRevision !== initialLifecycleRevision ||
            current.storePath !== initial.storePath ||
            current.canonicalKey !== initial.canonicalKey ||
            current.agentId !== initial.agentId))
      ) {
        reject(`Session ${sessionKey} changed; retry ${action}.`);
        return;
      }
      if (rejectInitializing(current.entry.initializationPending)) {
        return;
      }
      upstreamContext.assertCurrent();
      const archived = current.entry.archivedAt !== undefined;
      if ((archived || upstreamLink) && action !== "fork") {
        const message = archived
          ? `${action === "switch" ? "Branch switch" : "Rewind"} is unavailable for archived sessions.`
          : EXTERNAL_CONVERSATION_ERROR;
        reject(message);
        return;
      }
      const placementError = resolveSessionWorkerPlacementMutationError({
        action,
        context,
        key: sessionKey,
        sessionId: current.entry.sessionId,
      });
      if (placementError) {
        reject(placementError.message);
        return;
      }
      const targetKey =
        action === "fork"
          ? buildDashboardSessionKey(current.agentId, {
              incognito:
                current.entry.incognito === true || isIncognitoSessionKey(current.canonicalKey),
            })
          : current.canonicalKey;
      const expectedState = {
        sessionId: current.entry.sessionId,
        lifecycleRevision: current.entry.lifecycleRevision,
      };
      const upstreamForkHarness = upstreamLink
        ? resolveUpstreamForkHarness(upstreamLink)
        : undefined;
      if (upstreamLink && !upstreamForkHarness) {
        reject(EXTERNAL_CONVERSATION_ERROR);
        return;
      }
      const creation = resolveOperatorSessionCreation(client);
      const sandbox = action === "fork" ? resolveCreatorSandbox(cfg, creation) : undefined;
      const upstreamForkGuard =
        upstreamLink && upstreamForkHarness
          ? createUpstreamForkCurrentGuard({
              client,
              commitGuard: assertMutationCurrent,
              context,
              forkHarness: upstreamForkHarness,
              requestedAgentId,
              sessionKey,
              source: current,
              targetKey,
            })
          : { assertCurrent: assertMutationCurrent, assertRollbackCurrent: assertMutationCurrent };
      if (upstreamForkHarness) {
        try {
          upstreamForkGuard.assertCurrent();
        } catch (error) {
          if (error instanceof SessionMutationAuthorizationChangedError) {
            respond(false, undefined, error.error);
            return;
          }
          throw error;
        }
      }
      const upstreamFork =
        upstreamLink && upstreamForkHarness
          ? await withSessionInitializationSource(upstreamForkGuard, (assertCurrent) => {
              const forkParams = {
                targetKey,
                sandbox,
                source: {
                  agentId: current.agentId,
                  sessionId: initialSessionId,
                  sessionKey: current.canonicalKey,
                  storePath: current.storePath,
                  entryId,
                },
                upstream: {
                  catalogId: upstreamLink.catalogId,
                  hostId: upstreamLink.hostId,
                  kind: upstreamLink.upstreamKind,
                  threadId: upstreamLink.threadId,
                  ref: upstreamLink.upstreamRef,
                },
              };
              return upstreamForkHarness.contract === "v2"
                ? upstreamForkHarness.sessionFork.fork({
                    ...forkParams,
                    assertCurrent,
                  })
                : upstreamForkHarness.sessionFork.fork(forkParams);
            })
          : undefined;
      if (upstreamFork?.status === "failed") {
        respond(
          false,
          undefined,
          errorShape(
            upstreamFork.code === "upstream-unavailable"
              ? ErrorCodes.UNAVAILABLE
              : ErrorCodes.INVALID_REQUEST,
            upstreamFork.message,
            { details: { reason: upstreamFork.code } },
          ),
        );
        return;
      }
      if (upstreamFork?.status === "created") {
        // Canonical fork lineage stays upstream. Linked sessions intentionally do not enter
        // the local branch graph; branch listing/switching remains rejected for them above.
        respond(
          true,
          {
            sessionKey: upstreamFork.key,
            ...(upstreamFork.editorText !== undefined
              ? { editorText: upstreamFork.editorText }
              : {}),
          },
          undefined,
        );
        emitSessionsChanged(context, {
          sessionKey: upstreamFork.key,
          agentId: requestedAgentId,
          reason: "fork",
        });
        return;
      }
      const forkWorkspace =
        action === "fork"
          ? prepareSessionForkFilesystemRoot({
              cfg,
              parent: current.entry,
              targetAgentId: current.agentId,
              sessionKey: targetKey,
              sandboxRequired: sandbox === "required",
            })
          : undefined;
      if (forkWorkspace && !forkWorkspace.ok) {
        respond(false, undefined, forkWorkspace.error);
        return;
      }
      let result: MessageCutMutationResult;
      let forkRepository:
        | {
            workspaceId: string;
            sourceWorkspaceId: string;
            store: ReturnType<typeof getSessionRepositoryWorkspaceStore>;
            source: ReturnType<typeof captureOpenClawStateWorkerContext>;
          }
        | undefined;
      const repositoryEntrySource = captureSessionEntryMetadataRead(
        {
          agentId: current.agentId,
          sessionKey: current.canonicalKey,
          storePath: current.storePath,
        },
        assertMutationCurrent,
      );
      const memoryOwner = memory && captureSessionActorStorageOwner(memory);
      const readRepositoryEntry = (key: string) => {
        if (memory) {
          return memoryOwner?.owner?.readSession(key, memory.authority)?.entry;
        }
        if (repositoryEntrySource) {
          if (key === current.canonicalKey) {
            return repositoryEntrySource.readCurrent();
          }
          return captureSessionEntryMetadataRead(
            { agentId: current.agentId, sessionKey: key, storePath: current.storePath },
            assertMutationCurrent,
          )?.readCurrent();
        }
        return loadAccessorSessionEntryForGatewayTarget({
          key,
          cfg,
          agentId: current.agentId,
        }).entry;
      };
      const mutationParams = {
        agentId: current.agentId,
        commitGuard: assertMutationCurrent,
        sessionKey: current.canonicalKey,
        sessionStoreKey: current.canonicalKey,
        storePath: current.storePath,
      };
      const upstreamChanged = new SessionMutationAuthorizationChangedError(
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          action === "fork" ? "Session changed; retry fork." : EXTERNAL_CONVERSATION_ERROR,
        ),
      );
      const assertLocalUpstreamCurrent = () => {
        if (
          readCurrentSessionUpstreamLink(upstreamContext, current.canonicalKey, current.agentId)
        ) {
          throw upstreamChanged;
        }
      };
      try {
        if (action === "fork" && current.entry.repositoryWorkspaceId) {
          const repositories = getSessionRepositoryWorkspaceStore();
          const repositorySource = captureOpenClawStateWorkerContext({ path: repositories.path });
          const preparedSource = await repositories.prepare(current.entry.repositoryWorkspaceId);
          const source = preparedSource.workspace;
          if (!source) {
            throw new Error("Repository workspace changed before session fork");
          }
          const assertRepositoryOwnerCurrent = () => {
            repositorySource.admission.assertCurrent();
            assertMutationCurrent();
            if (
              source.agentId !== current.agentId ||
              source.sessionKey !== current.canonicalKey ||
              preparedSource.current()?.revision !== source.revision
            ) {
              throw new Error("Repository workspace changed before session fork");
            }
          };
          const assertRepositoryCurrent = () => {
            assertRepositoryOwnerCurrent();
            assertLocalUpstreamCurrent();
            const sourceEntry = readRepositoryEntry(current.canonicalKey);
            if (
              sourceEntry?.sessionId !== initialSessionId ||
              sourceEntry.lifecycleRevision !== initialLifecycleRevision ||
              sourceEntry.repositoryWorkspaceId !== source.workspaceId
            ) {
              throw new Error("Repository workspace changed before session fork");
            }
          };
          assertRepositoryCurrent();
          const forked = await forkSessionRepositoryWorkspace({
            sourceWorkspaceId: current.entry.repositoryWorkspaceId,
            agentId: current.agentId,
            sessionKey: targetKey,
            assertCurrent: assertRepositoryCurrent,
          });
          forkRepository = {
            workspaceId: forked.workspaceId,
            sourceWorkspaceId: source.workspaceId,
            store: repositories,
            source: repositorySource,
          };
          mutationParams.commitGuard = assertRepositoryOwnerCurrent;
        }
        const forkParams = {
          ...mutationParams,
          entryId,
          targetKey,
          repositoryWorkspaceId: forkRepository?.workspaceId,
          forkWorkspace: forkWorkspace?.value,
          creation: { ...creation, sandbox },
        };
        result = await mutateSessionAtMessageWithPreconditions(
          action === "fork" ? forkParams : { ...mutationParams, entryId },
          action,
          memory ? undefined : expectedState,
          {
            sourceRepositoryWorkspaceId: forkRepository?.sourceWorkspaceId,
            assertUpstreamCurrent: assertLocalUpstreamCurrent,
          },
        );
      } catch (error) {
        if (error === upstreamChanged) {
          respond(false, undefined, upstreamChanged.error);
          return;
        }
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        if (error instanceof ModelSelectionLockedError) {
          reject(error.message);
          return;
        }
        reject(`Failed to ${action} the local session. Try again.`, ErrorCodes.UNAVAILABLE);
        return;
      } finally {
        if (forkRepository) {
          const { workspaceId, store, source } = forkRepository;
          const forkEntry = () => readRepositoryEntry(targetKey);
          if (forkEntry()?.repositoryWorkspaceId !== workspaceId) {
            await store.delete({
              workspaceId,
              assertCurrent: () => {
                source.admission.assertCurrent();
                if (forkEntry()?.repositoryWorkspaceId === workspaceId) {
                  throw new Error("Repository fork was committed before cleanup");
                }
              },
            });
          }
        }
      }
      if (result.status !== "created") {
        const actionLabel = action === "switch" ? "branch switch" : action;
        const message = {
          conflict: `Session changed; retry ${action}.`,
          "missing-session": "session not found",
          "missing-entry": `${action === "switch" ? "branch" : "message"} entry not found: ${entryId}`,
          "not-branch-tip": `entry is not a branch tip: ${entryId}`,
          "already-active": `branch is already active: ${entryId}`,
          "not-user-message": `entry is not a user message: ${entryId}`,
          "off-active-path": `message entry is not on the active path: ${entryId}`,
          "unsupported-storage": `session transcript storage does not support ${actionLabel}`,
          failed: `failed to ${actionLabel} session`,
        }[result.status];
        reject(
          message,
          result.status === "failed" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
        );
        return;
      }
      const committedResult = result;
      const complete = async () => {
        const editorAttachments =
          action === "switch"
            ? []
            : [
                ...("editorAttachments" in committedResult
                  ? (committedResult.editorAttachments ?? [])
                  : []),
                ...(await resolveEditorMediaAttachments(
                  "editorMediaRefs" in committedResult
                    ? committedResult.editorMediaRefs
                    : undefined,
                )),
              ];
        if (action !== "fork") {
          clearSessionLifecycleQueues({
            keys: lifecycleIdentities,
            agentId: current.agentId,
            sessionKey: current.canonicalKey,
            sessionId: initialSessionId,
            // History is committed; settling its original queues must finish after revocation.
            assertCurrent: () => {},
          });
        } else {
          await recordSessionCreated(cfg, {
            sessionKey: committedResult.key,
            agentId: current.agentId,
            entry: committedResult.entry,
          });
        }
        respond(
          true,
          action === "switch"
            ? {}
            : {
                ...(action === "fork" ? { sessionKey: committedResult.key } : {}),
                ...("editorText" in committedResult && committedResult.editorText
                  ? { editorText: committedResult.editorText }
                  : {}),
                ...(editorAttachments.length > 0 ? { editorAttachments } : {}),
              },
          undefined,
        );
        const payload = {
          sessionKey: action === "fork" ? committedResult.key : current.canonicalKey,
          sessionId: committedResult.entry.sessionId,
          agentId: requestedAgentId,
          reason: action === "switch" ? "branch-switch" : action,
        };
        if (memory) {
          try {
            await withPreparedSessionEventRow(
              getSessionRowProjection(context),
              payload.sessionKey,
              payload.agentId,
              (sessionRows) =>
                emitSessionsChanged(context, payload, { preparedPublication: true, sessionRows }),
            );
          } catch (error) {
            sessionLog.warn(`Session change preparation failed: ${String(error)}`);
            emitSessionsChanged(context, payload, { preparedPublication: true });
          }
        } else {
          emitSessionsChanged(context, payload);
        }
      };
      if (memory) {
        const assertCurrent = readGatewayRequestMutationAuthority(options).assertLifetimeCurrent;
        // The mutation consumed the old instance authority; publication uses live recipient policy.
        const actor = await memory.actor.storage!.acquire(committedResult.key, {
          assertCurrent,
          assertReadable: assertCurrent,
        });
        try {
          await runWithSessionActorStorage(
            { ...memory, actor, authority: { assertCurrent, authorize() {} } },
            complete,
          );
        } finally {
          await actor.release();
        }
      } else {
        await complete();
      }
    },
  });
}
