import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  missingScopeErrorShape,
  normalizeSessionColorValue,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../agents/inherited-tool-deny.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import {
  forkSessionFromParentWithDecision,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../auto-reply/reply/session-fork.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  loadExactSessionEntryFromStoreReadOnly,
  patchSessionEntryCore,
  resolveSessionEntryAccessTarget,
} from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  isIncognitoSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
} from "../sessions/agent-harness-session-key.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { recordSessionCreated } from "../sessions/session-created.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "./operator-role-policy.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import {
  prepareSessionCreateFilesystemRoot,
  prepareSessionForkFilesystemRoot,
} from "./server-methods/session-create-root.js";
import {
  prepareSessionPatchRuntimeSelection,
  refreshSessionPatchQueuedSelection,
} from "./server-methods/sessions-patch-model-selection.js";
import { existingSessionSelectionWouldChange } from "./session-create-existing-selection.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";
import { resolveSessionCreateInheritance } from "./session-create-inheritance.js";
import {
  createSessionCreateCommitGuard,
  prepareSessionCreateDefaultAccount,
  prepareSessionCreateModelSelection,
  resolveSessionForkMaxTokens,
} from "./session-create-model-selection.js";
import type {
  CreatedGatewaySession,
  CreateGatewaySessionParams,
  CreateGatewaySessionResult,
  GatewaySessionCommitResult,
} from "./session-create-service.types.js";
import { readSessionCreateTarget } from "./session-create-target.js";
import {
  type PreparedGatewaySessionLifecycle,
  projectPreparedSessionWorkspace,
  rollbackGatewaySessionPreparation,
} from "./session-lifecycle-preparation.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { isSessionVisibilityAllowed, resolveSessionVisibility } from "./session-sharing.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const loadSessionLifecycleRuntime = createLazyRuntimeModule(
  () => import("./server-methods/sessions.runtime.js"),
);

export function buildDashboardSessionKey(
  agentId: string,
  options: { incognito?: boolean } = {},
): string {
  const opaqueId = `${options.incognito ? "incognito-" : ""}${randomUUID()}`;
  return `agent:${agentId}:dashboard:${opaqueId}`;
}

export async function createGatewaySession(
  params: CreateGatewaySessionParams,
): Promise<CreateGatewaySessionResult> {
  const { personalModelSelection, personalAccountDefaults } = params;
  if (params.agentRuntime !== undefined && (!params.model || params.catalogTarget)) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "agentRuntime requires an explicit canonical provider/model selection",
      ),
    };
  }
  const requestedProfile = splitTrailingAuthProfile(
    params.catalogTarget?.model ?? params.model ?? "",
  ).profile;
  if (
    requestedProfile &&
    isUserModelAuthProfileId(requestedProfile) &&
    personalModelSelection?.authProfileId !== requestedProfile
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.FORBIDDEN,
        "Choose your personal account from an identified Gateway connection.",
      ),
    };
  }
  // Fresh account authority covers title generation and resource preparation,
  // not just the final row. An inherited parent pin is not a new selection.
  let selectedDefaultProfile: string | undefined;
  let validateRuntimeSelection: (() => ErrorShape | undefined) | undefined;
  const commitGuard =
    personalModelSelection ||
    params.operatorAuthority ||
    personalAccountDefaults ||
    params.activeParentFork ||
    params.preparedModelSelection ||
    typeof params.model === "string" ||
    params.agentRuntime !== undefined
      ? createSessionCreateCommitGuard({
          assertCallerCurrent: params.commitGuard,
          operatorAuthority: params.operatorAuthority,
          selections: [
            params.activeParentFork,
            params.preparedModelSelection,
            personalModelSelection,
            personalAccountDefaults,
          ],
          personalAccountDefaults,
          readDefaultProfile: () => selectedDefaultProfile,
          validateSelection: () => validateRuntimeSelection?.(),
        })
      : params.commitGuard;
  commitGuard?.();
  // Presentation titles do not claim labels. Bound the snapshot at the shared
  // creator so every native owner gets the same surrogate-safe storage contract.
  const displayName = truncateUtf16Safe(params.displayName?.trim() ?? "", 500).trimEnd();
  const requestedKey = normalizeOptionalString(params.key);
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey);
  const projectId = normalizeOptionalString(params.projectId);
  const pendingProjectGitUrl = normalizeOptionalString(params.pendingProjectGitUrl);
  const requestedToolOverrides = params.toolOverrides !== undefined;
  const explicitAgentId = params.agentId;
  const explicitKeyAgentId = parseAgentSessionKey(requestedKey)?.agentId;
  const selectedAgent = resolveRequestedSessionAgentId(
    params.cfg,
    requestedKey ?? (explicitAgentId === undefined ? "main" : undefined),
    explicitAgentId ?? explicitKeyAgentId,
  );
  if (!selectedAgent.ok) {
    return selectedAgent;
  }
  const agentId = selectedAgent.agentId;
  const catalogModel = normalizeOptionalString(params.catalogTarget?.model);
  const catalogAgentRuntime = normalizeOptionalAgentRuntimeId(params.catalogTarget?.agentRuntime);
  const catalogPluginOwnerId = normalizeOptionalString(params.catalogTarget?.pluginOwnerId);
  if (params.catalogTarget && (!catalogModel || !catalogAgentRuntime || !catalogPluginOwnerId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "invalid catalog session target"),
    };
  }
  if (params.succeedsParent !== undefined) {
    if (!parentSessionKey) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires parentSessionKey"),
      };
    }
    if (params.emitCommandHooks !== true) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires emitCommandHooks"),
      };
    }
    if (params.succeedsParent && params.fork === true) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "succeedsParent conflicts with fork: a fork runs in parallel to its parent",
        ),
      };
    }
  }
  if (params.atomicInitialization === true && (!params.afterCreate || params.initialEntry)) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "atomic initialization requires afterCreate and cannot use trusted initial state",
      ),
    };
  }
  const loweredRequestedKey = normalizeOptionalLowercaseString(requestedKey);
  const explicitTargetKey = requestedKey
    ? loweredRequestedKey === "global" || loweredRequestedKey === "unknown"
      ? loweredRequestedKey
      : toAgentStoreSessionKey({
          agentId,
          requestKey: requestedKey,
          mainKey: params.cfg.session?.mainKey,
        })
    : undefined;
  const explicitTargetParts = parseAgentSessionKey(explicitTargetKey);
  const explicitIncognito = isIncognitoSessionKey(explicitTargetKey);
  const explicitDashboardIncognito =
    explicitIncognito &&
    explicitTargetParts?.agentId === agentId &&
    explicitTargetParts.rest.startsWith("dashboard:");
  if (explicitIncognito && params.incognito !== true) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "incognito-shaped session keys require incognito: true",
      ),
    };
  }
  if (params.incognito === true && explicitTargetKey) {
    if (!explicitDashboardIncognito) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions are web-only"),
      };
    }
    const durableStorePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    const durableEntry = loadExactSessionEntryFromStoreReadOnly({
      agentId,
      storePath: durableStorePath,
      sessionKey: explicitTargetKey,
      projection: "list",
    });
    if (durableEntry || loadGatewaySessionEntryReadOnly(explicitTargetKey).entry) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "incognito is immutable and requires a new session key",
        ),
      };
    }
  }
  if (
    params.catalogTarget &&
    explicitTargetKey &&
    !explicitTargetKey.startsWith(`agent:${agentId}:dashboard:`)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "catalog sessions require a generated dashboard key",
      ),
    };
  }

  const authorizedHarnessCreation = Boolean(
    explicitTargetKey &&
    params.initialEntry &&
    normalizeOptionalAgentRuntimeId(params.authorizedAgentHarnessId) ===
      normalizeOptionalAgentRuntimeId(params.initialEntry.agentHarnessId) &&
    isAgentHarnessSessionKeyOwnedBy(explicitTargetKey, params.authorizedAgentHarnessId),
  );
  const authorizedPluginCreation = Boolean(
    explicitTargetKey &&
    params.initialEntry?.pluginOwnerId &&
    params.authorizedPluginId === params.initialEntry.pluginOwnerId,
  );
  if (params.initialEntry?.pluginOwnerId && !authorizedPluginCreation) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "trusted plugin session owner is not authorized",
      ),
    };
  }
  const existingHarnessEntry =
    explicitTargetKey && isAgentHarnessSessionKey(explicitTargetKey)
      ? resolveSessionEntryAccessTarget({ cfg: params.cfg, sessionKey: explicitTargetKey }).entry
      : undefined;
  if (
    explicitTargetKey &&
    isAgentHarnessSessionKey(explicitTargetKey) &&
    !authorizedHarnessCreation &&
    (!existingHarnessEntry || existingHarnessEntry.modelSelectionLocked === true)
  ) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE),
    };
  }

  if (params.fork === true && !parentSessionKey) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "fork requires parentSessionKey"),
    };
  }
  if (params.forkFrom && params.fork !== true) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "forkFrom requires fork=true"),
    };
  }
  if (params.spawnDepth !== undefined) {
    if (!Number.isInteger(params.spawnDepth) || params.spawnDepth < 1) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth must be an integer >= 1"),
      };
    }
    if (!parentSessionKey) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth requires parentSessionKey"),
      };
    }
  }
  if (params.spawnToolPolicy && params.spawnDepth === undefined) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "spawn tool policy requires spawnDepth"),
    };
  }
  let canonicalParentSessionKey: string | undefined;
  let parentSessionEntry: SessionEntry | undefined;
  let parentSelectedAgentId: string | undefined;
  let parentSessionTarget: ReturnType<typeof resolveGatewaySessionStoreTarget> | undefined;
  if (parentSessionKey) {
    const parentRequestedAgent = resolveRequestedSessionAgentId(
      params.cfg,
      parentSessionKey,
      !parseAgentSessionKey(parentSessionKey) &&
        ["global", "unknown"].includes(parentSessionKey.toLowerCase())
        ? explicitAgentId
        : undefined,
    );
    if (!parentRequestedAgent.ok) {
      return parentRequestedAgent;
    }
    parentSelectedAgentId = parentRequestedAgent.agentId;
    const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, {
      agentId: parentSelectedAgentId,
    });
    if (!parent.entry?.sessionId) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown parent session: ${parentSessionKey}`,
        ),
      };
    }
    const parentOwnershipError = resolvePluginSessionOwnershipError({
      action: params.fork === true ? "fork" : "link",
      entry: parent.entry,
      key: parent.canonicalKey,
      pluginOwnerId: params.authorizedPluginId,
    });
    if (parentOwnershipError) {
      return { ok: false, error: parentOwnershipError };
    }
    if (isModelSelectionLocked(parent.entry)) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE),
      };
    }
    canonicalParentSessionKey = parent.canonicalKey;
    parentSessionEntry = parent.entry;
    parentSessionTarget = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: parentSessionKey,
      ...(parentSelectedAgentId ? { agentId: parentSelectedAgentId } : {}),
    });
  }
  if (
    params.activeParentFork &&
    (params.fork !== true ||
      parentSelectedAgentId !== agentId ||
      resolveGatewaySessionStoreTarget({
        cfg: params.cfg,
        key: params.activeParentFork.requesterSessionKey,
        agentId,
      }).canonicalKey !== canonicalParentSessionKey)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "active fork parent must match the same-agent requester",
      ),
    };
  }
  const parentIncognito =
    parentSessionEntry?.incognito === true || isIncognitoSessionKey(canonicalParentSessionKey);
  const incognito = params.incognito === true || parentIncognito;
  if (
    incognito &&
    params.requestingOperatorScopes !== undefined &&
    !params.requestingOperatorScopes.includes(ADMIN_SCOPE)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `incognito sessions require gateway scope: ${ADMIN_SCOPE}`,
      ),
    };
  }
  if (incognito && canonicalParentSessionKey && !parentIncognito) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "incognito sessions cannot have durable parents",
      ),
    };
  }
  if (parentIncognito && explicitTargetKey) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions are web-only"),
    };
  }

  if (
    canonicalParentSessionKey &&
    explicitTargetKey &&
    resolveGatewaySessionStoreTarget({ cfg: params.cfg, key: explicitTargetKey, agentId })
      .canonicalKey === canonicalParentSessionKey
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "sessions.create key must differ from parentSessionKey",
      ),
    };
  }

  const targetSessionKey = explicitTargetKey ?? buildDashboardSessionKey(agentId, { incognito });
  const creationTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: targetSessionKey,
    agentId,
  });
  const initialTargetEntry = explicitTargetKey
    ? resolveSessionEntryAccessTarget({
        cfg: params.cfg,
        sessionKey: creationTarget.canonicalKey,
        agentId: creationTarget.agentId,
      }).entry
    : undefined;
  if (explicitTargetKey && !params.initialEntry) {
    // A trusted initializer holds the lifecycle fence through afterCreate. Waiting
    // on that fence would deadlock callers that must reject its visible pending row.
    if (initialTargetEntry?.initializationPending === true) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${creationTarget.canonicalKey} is still initializing; retry creation later.`,
        ),
      };
    }
  }
  const agentMainSessionKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
  // Durable dashboard sessions parent to main for flow-up notices and sidebar threads.
  // Incognito roots omit durable lineage so notices cannot cross the storage boundary.
  const dashboardParentSessionKey =
    !parentSessionKey &&
    !params.authorizedPluginId &&
    !incognito &&
    params.fork !== true &&
    (params.cfg.session?.dmScope ?? "main") === "main" &&
    params.cfg.session?.scope !== "global" &&
    targetSessionKey !== agentMainSessionKey
      ? agentMainSessionKey
      : undefined;

  if (
    canonicalParentSessionKey &&
    params.fork !== true &&
    params.emitCommandHooks === true &&
    !requestedKey &&
    params.resetMainWhenUnspecified === true &&
    !requestedToolOverrides &&
    !parentIncognito &&
    // Catalog targets need a fresh locked row; resetting main would return before
    // the catalog-owned model/runtime pair is persisted.
    !params.catalogTarget &&
    params.cfg.session?.dmScope === "main"
  ) {
    const parentAgentId = normalizeAgentId(
      parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,
    );
    const parentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: parentAgentId });
    if (canonicalParentSessionKey === parentMainKey) {
      if (params.visibility) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            "sessions.create visibility requires a new session",
          ),
        };
      }
      const { performGatewaySessionReset } = await loadSessionLifecycleRuntime();
      const spawnedCwd = normalizeOptionalString(params.spawnedCwd);
      const execCwd = normalizeOptionalString(params.execCwd);
      const resetResult = await performGatewaySessionReset({
        key: canonicalParentSessionKey,
        ...(parentSelectedAgentId ? { agentId: parentSelectedAgentId } : {}),
        ...(params.requestingOperatorProfileId
          ? { requestingOperatorProfileId: params.requestingOperatorProfileId }
          : {}),
        ...(params.operatorRoleActor ? { operatorRoleActor: params.operatorRoleActor } : {}),
        reason: "new",
        commandSource: params.commandSource,
        ...(params.creation ? { creation: params.creation } : {}),
        ...(spawnedCwd ? { spawnedCwd } : {}),
        ...(params.sessionRoot ? { sessionRoot: params.sessionRoot } : {}),
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
        ...(params.fastMode !== undefined
          ? {
              fastModeSelection: {
                value: params.fastMode,
                allowExistingChange: params.allowExistingModelSelection === true,
              },
            }
          : {}),
        ...(params.prepareLifecycle ? { prepareLifecycle: params.prepareLifecycle } : {}),
        ...(params.onLifecycleCleanupError
          ? { onLifecycleCleanupError: params.onLifecycleCleanupError }
          : {}),
        ...(params.execNode ? { execNode: params.execNode } : {}),
        ...(execCwd ? { execCwd } : {}),
        ...(params.clearExecBinding ? { clearExecBinding: true } : {}),
        ...(params.clearSpawnedCwd && !spawnedCwd ? { clearSpawnedCwd: true } : {}),
        ...(params.armSessionDiffBaselineCapture ? { armSessionDiffBaselineCapture: true } : {}),
        ...(commitGuard ? { assertAuthorizedInstance: commitGuard } : {}),
      });
      if (!resetResult.ok) {
        return resetResult;
      }
      if ("incognitoDeleted" in resetResult) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions cannot reset in place"),
        };
      }
      return {
        ok: true,
        key: resetResult.key,
        agentId: resetResult.agentId,
        entry: projectPublicSessionEntry(resetResult.entry),
        resolved: resetResult.resolved,
        resetExisting: true,
        postCommit: { status: "completed" },
      };
    }
  }

  let createdContext: CreatedGatewaySession | undefined;
  let createdNewEntry = false;
  let preparedLifecycle: PreparedGatewaySessionLifecycle | undefined;
  let lifecyclePreparationCommitted = false;
  const holdParentLifecycle =
    params.creation?.via === "spawn" ||
    params.emitCommandHooks === true ||
    params.fork === true ||
    params.authorizedPluginId !== undefined;
  const spawnToolPolicy =
    params.spawnToolPolicy && canonicalParentSessionKey
      ? {
          completionOwnerSessionKey: normalizeOptionalString(
            params.spawnToolPolicy.completionOwnerSessionKey,
          ),
          allow: normalizeInheritedToolAllowlist(params.spawnToolPolicy.allow),
          deny: normalizeInheritedToolDenylist(params.spawnToolPolicy.deny),
          parentSessionKey: canonicalParentSessionKey,
        }
      : undefined;
  const createChildSession = async (): Promise<GatewaySessionCommitResult> => {
    commitGuard?.();
    let currentParentSessionEntry = parentSessionEntry;
    if (canonicalParentSessionKey && parentSessionTarget && holdParentLifecycle) {
      const currentParent = loadGatewaySessionEntryReadOnly(
        canonicalParentSessionKey,
        parentSelectedAgentId ? { agentId: parentSelectedAgentId } : undefined,
      );
      const currentParentEntry = currentParent.entry;
      if (
        !currentParentEntry?.sessionId ||
        currentParentEntry.sessionId !== parentSessionEntry?.sessionId ||
        currentParentEntry.lifecycleRevision !== parentSessionEntry?.lifecycleRevision
      ) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Parent session ${parentSessionKey} changed before child creation; retry.`,
          ),
        };
      }
      currentParentSessionEntry = currentParentEntry;
      const parentOwnershipError = resolvePluginSessionOwnershipError({
        action: params.fork === true ? "fork" : "link",
        entry: currentParentEntry,
        key: canonicalParentSessionKey,
        pluginOwnerId: params.authorizedPluginId,
      });
      if (parentOwnershipError) {
        return { ok: false, error: parentOwnershipError };
      }
      if (
        (params.emitCommandHooks === true || params.fork === true) &&
        isModelSelectionLocked(currentParentEntry)
      ) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE),
        };
      }
      const parentHasActiveWork =
        (params.emitCommandHooks === true || params.fork === true) &&
        (isEmbeddedAgentRunActive(currentParentEntry.sessionId) ||
          isSessionWorkAdmissionActive(parentSessionTarget.storePath, [
            canonicalParentSessionKey,
            currentParentEntry.sessionId,
          ]));
      if (
        parentHasActiveWork &&
        (params.emitCommandHooks === true ||
          (params.forkFrom !== "last-completed" && !params.activeParentFork))
      ) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Parent session ${parentSessionKey} is still active; try again in a moment.`,
          ),
        };
      }
    }

    if (canonicalParentSessionKey && parentSessionTarget && params.emitCommandHooks === true) {
      const parentEntry = currentParentSessionEntry;
      const parentAgentId = normalizeAgentId(
        parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,
      );
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, parentAgentId);
      if (hasInternalHookListeners("command", "new")) {
        await triggerInternalHook(
          createInternalHookEvent("command", "new", canonicalParentSessionKey, {
            agentId: parentAgentId,
            sessionEntry: parentEntry,
            previousSessionEntry: parentEntry,
            commandSource: params.commandSource,
            cfg: params.cfg,
            storePath: parentSessionTarget.storePath,
            workspaceDir,
          }),
        );
      }
      const { emitGatewayBeforeResetPluginHook } = await loadSessionLifecycleRuntime();
      await emitGatewayBeforeResetPluginHook({
        cfg: params.cfg,
        key: canonicalParentSessionKey,
        target: parentSessionTarget,
        storePath: parentSessionTarget.storePath,
        entry: parentEntry,
        reason: "new",
      });
    }

    // The locked parent owns delegated isolation, including signed remote callers whose
    // transport context carries only agent identity and cannot carry creator authority.
    const { creation, ownerAssignment: inheritedSpawnOwner } = resolveSessionCreateInheritance({
      creation: params.creation,
      parent: currentParentSessionEntry,
    });
    const target = creationTarget;
    const targetRead = readSessionCreateTarget(
      params,
      target,
      initialTargetEntry?.sessionId,
      targetLifecycleIdentities,
    );
    if (!targetRead.ok) {
      return targetRead;
    }
    const currentTargetEntry = targetRead.value;
    const creationSandbox =
      creation?.sandbox ?? (creation ? resolveCreatorSandbox(params.cfg, creation) : undefined);
    const sandboxRequired =
      currentTargetEntry?.sandbox === "required" || creationSandbox === "required";
    const forkWorkspace =
      params.fork === true &&
      currentParentSessionEntry &&
      !currentTargetEntry &&
      parentSessionTarget?.agentId === target.agentId &&
      !projectId &&
      !params.spawnedCwd &&
      !params.sessionRoot &&
      !params.execNode &&
      !params.prepareLifecycle &&
      !params.pendingWorktree &&
      !params.pendingProjectGitUrl
        ? prepareSessionForkFilesystemRoot({
            cfg: params.cfg,
            parent: currentParentSessionEntry,
            targetAgentId: target.agentId,
            sessionKey: target.canonicalKey,
            sandboxRequired,
          })
        : undefined;
    if (forkWorkspace && !forkWorkspace.ok) {
      return { ok: false, error: forkWorkspace.error };
    }
    const inheritedWorkspace = forkWorkspace?.value;
    const requestedRoot = normalizeOptionalString(params.spawnedCwd ?? params.sessionRoot);
    // The parent lock has resolved inherited policy; validate direct roots before binding
    // a child or allowing transcript/baseline preparation to process the selected checkout.
    if (sandboxRequired && requestedRoot && !params.execNode) {
      const root = prepareSessionCreateFilesystemRoot({
        cfg: params.cfg,
        enforceSandboxContainment: true,
        sandboxRequired,
        requestedProjectId: projectId,
        sessionCwd: requestedRoot,
        sessionKey: target.canonicalKey,
        targetAgentId: target.agentId,
      });
      if (!root.ok) {
        return { ok: false, error: root.error };
      }
    }
    const modelSelection = prepareSessionCreateModelSelection({
      cfg: params.cfg,
      agentId: target.agentId,
      input:
        params.catalogTarget ??
        (params.model ? { model: params.model, agentRuntime: params.agentRuntime } : undefined),
      parentEntry: currentParentSessionEntry,
      preparedModelSelection: params.preparedModelSelection?.ref,
      operatorAuthority: params.operatorAuthority,
    });
    if (!modelSelection.ok) {
      return modelSelection;
    }
    validateRuntimeSelection = modelSelection.validate;
    commitGuard?.();
    const preparationResult = params.prepareLifecycle
      ? await params.prepareLifecycle({
          agentId: target.agentId,
          entry: currentTargetEntry,
          key: target.canonicalKey,
          storePath: target.storePath,
          titleModelSelection: modelSelection.selection,
          projectId,
          sandboxRequired,
        })
      : undefined;
    if (preparationResult && !preparationResult.ok) {
      return { ok: false, error: preparationResult.error };
    }
    preparedLifecycle = preparationResult?.value;
    const pendingWorktree = preparedLifecycle?.pendingWorktree ?? params.pendingWorktree;
    const spawnedCwd = normalizeOptionalString(
      preparedLifecycle?.spawnedCwd ?? params.spawnedCwd ?? inheritedWorkspace?.spawnedCwd,
    );
    const sessionRoot = normalizeOptionalString(
      preparedLifecycle?.sessionRoot ??
        params.sessionRoot ??
        inheritedWorkspace?.sessionRoot ??
        params.defaultSessionRoot,
    );
    const runtimeCwd = spawnedCwd ?? sessionRoot;

    const loadModelCatalog = params.loadGatewayModelCatalogSnapshot;
    let preparedModelCatalog: ModelCatalogSnapshot | undefined;
    const created = await createSessionEntryWithTranscript<ErrorShape>(
      {
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      },
      async ({ existingEntry, targetEntry, isLabelInUse }) => {
        // This callback owns generated and explicit keys alike; no existing row
        // is the canonical signal that this request will actually create one.
        if (!existingEntry) {
          const creationError = authorizeGatewaySessionCreation({
            cfg: params.cfg,
            agentId: target.agentId,
            ...(params.operatorRoleActor
              ? { actor: params.operatorRoleActor }
              : { profileId: params.requestingOperatorProfileId }),
          });
          if (creationError) {
            return { ok: false, error: creationError };
          }
        }
        if (
          isAgentHarnessSessionKey(target.canonicalKey) &&
          !authorizedHarnessCreation &&
          (!existingEntry || existingEntry.modelSelectionLocked === true)
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
            ),
          };
        }
        if (!params.initialEntry && existingEntry?.initializationPending === true) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session ${target.canonicalKey} is still initializing; retry creation later.`,
            ),
          };
        }
        if (params.initialEntry && existingEntry !== undefined) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "trusted initial session state requires a new session",
            ),
          };
        }
        if (params.catalogTarget && existingEntry !== undefined) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "catalog session target requires a new session",
            ),
          };
        }
        if ((pendingProjectGitUrl || pendingWorktree) && existingEntry !== undefined) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "workspace preparation requires a new session",
            ),
          };
        }
        if (spawnToolPolicy && existingEntry !== undefined) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "spawn tool policy requires a new session",
            ),
          };
        }
        if (
          params.visibility &&
          existingEntry === undefined &&
          !isSessionVisibilityAllowed(params.cfg, params.visibility)
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `session visibility is disabled: ${params.visibility}`,
              { details: { code: "SESSION_VISIBILITY_DISABLED", visibility: params.visibility } },
            ),
          };
        }
        if (
          params.visibility &&
          existingEntry !== undefined &&
          resolveSessionVisibility(existingEntry) !== params.visibility
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "sessions.create visibility requires a new session",
            ),
          };
        }
        // Adoption of an existing key must not stamp provenance or emit a
        // `created` event; only a genuinely new row is a node creation.
        createdNewEntry = existingEntry === undefined;
        const requestedModel = normalizeOptionalString(params.model);
        const requestedContextWindow = normalizeOptionalString(params.contextWindow);
        const requestedThinkingLevel = normalizeOptionalString(params.thinkingLevel);
        const requestedFastMode = params.fastMode;
        if (existingEntry?.sessionId && params.allowExistingModelSelection !== true) {
          const gateDefaultModel = resolveDefaultModelForAgent({
            cfg: params.cfg,
            agentId: target.agentId,
          });
          const sessionSelectionWouldChange = await existingSessionSelectionWouldChange({
            agentId: target.agentId,
            cfg: params.cfg,
            catalogModel,
            defaultModel: gateDefaultModel.model,
            defaultProvider: gateDefaultModel.provider,
            existingEntry,
            loadGatewayModelCatalogSnapshot: params.loadGatewayModelCatalogSnapshot,
            requestedModel,
            requestedAgentRuntime: params.agentRuntime,
            requestedContextWindow,
            requestedFastMode,
            requestedThinkingLevel,
            subagentModelHint: isSubagentSessionKey(target.canonicalKey)
              ? resolveSubagentConfiguredModelSelection({
                  cfg: params.cfg,
                  agentId: target.agentId,
                })
              : undefined,
          });
          if (sessionSelectionWouldChange) {
            return {
              ok: false,
              error: missingScopeErrorShape({
                missingScope: ADMIN_SCOPE,
                requiredScopes: [ADMIN_SCOPE],
              }),
            };
          }
        }
        const patched = await projectSessionsPatchEntry({
          cfg: params.cfg,
          existingEntry: targetEntry,
          isLabelInUse,
          storeKey: target.canonicalKey,
          agentId: target.agentId,
          preparedSessionRoot: sessionRoot,
          preparedAgentRuntime: catalogAgentRuntime,
          // Patch appliers read key presence as caller intent (present = change,
          // null = clear), so omitted create fields must stay absent: a present
          // undefined model trips the selection lock and drops modelFallback,
          // and present undefined contextWindow/thinkingLevel take the
          // reject-invalid branch instead of the model-change clearing branch.
          patch: {
            key: target.canonicalKey,
            label: normalizeOptionalString(params.label),
            category: normalizeOptionalString(params.category),
            ...((catalogModel ?? requestedModel) ? { model: catalogModel ?? requestedModel } : {}),
            ...(params.agentRuntime !== undefined ? { agentRuntime: params.agentRuntime } : {}),
            ...(requestedContextWindow ? { contextWindow: requestedContextWindow } : {}),
            ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
            ...(requestedFastMode !== undefined ? { fastMode: requestedFastMode } : {}),
            ...(requestedToolOverrides ? { toolOverrides: params.toolOverrides } : {}),
            ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
          },
          loadGatewayModelCatalogSnapshot: loadModelCatalog
            ? async () => {
                preparedModelCatalog = await loadModelCatalog();
                return preparedModelCatalog;
              }
            : undefined,
          authorizedAgentHarnessId: params.authorizedAgentHarnessId,
          personalModelSelection: params.personalModelSelection,
          operatorAuthority: params.operatorAuthority,
          preparedModelSelection: params.preparedModelSelection?.ref,
        });
        if (!patched.ok) {
          return patched;
        }
        // Bind automatic intent before using the patch owner's canonical selection.
        const spawnModelAutoSelection =
          params.creation?.spawnModelAutoSelection?.model === requestedModel
            ? params.creation?.spawnModelAutoSelection
            : undefined;
        if (
          requestedToolOverrides &&
          existingEntry !== undefined &&
          stableStringify(existingEntry.toolOverrides) !==
            stableStringify(patched.entry.toolOverrides)
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "sessions.create toolOverrides requires a new session",
            ),
          };
        }
        const execNode = normalizeOptionalString(params.execNode);
        const execCwd = normalizeOptionalString(params.execCwd);
        const initialAgentHarnessId = params.initialEntry
          ? normalizeOptionalString(params.initialEntry.agentHarnessId)
          : undefined;
        // Initializers compare their callback snapshot with the stored row during finalization.
        // Normalize before both so persistence cannot make this creation look like external drift.
        const initialColor = params.initialEntry?.color
          ? normalizeSessionColorValue(params.initialEntry.color)
          : null;
        if (params.initialEntry && !initialAgentHarnessId && !authorizedPluginCreation) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              params.initialEntry?.agentHarnessId !== undefined
                ? "initial agentHarnessId must be non-empty"
                : "trusted initial session state requires an authorized owner",
            ),
          };
        }
        if (
          params.initialEntry?.modelSelectionLocked !== undefined &&
          !params.initialEntry.modelSelectionLocked
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "initial modelSelectionLocked must be true when provided",
            ),
          };
        }
        const catalogResolvedModel = params.catalogTarget
          ? resolveSessionModelRef(params.cfg, patched.entry, target.agentId)
          : undefined;
        const initializedEntry: InternalSessionEntry = {
          ...patched.entry,
          ...inheritedWorkspace,
          ...(createdNewEntry && displayName ? { displayName } : {}),
          ...(createdNewEntry && spawnModelAutoSelection
            ? {
                modelOverrideSource: "auto" as const,
                ...(spawnModelAutoSelection.hasFallbackOrigin
                  ? {
                      modelOverrideFallbackOriginProvider: patched.entry.providerOverride,
                      modelOverrideFallbackOriginModel: patched.entry.modelOverride,
                    }
                  : {}),
              }
            : {}),
          // New rows must expose the same canonical delivery shape to callbacks
          // that the SQLite writer persists, or guarded finalization sees its own write as drift.
          ...(existingEntry === undefined && patched.entry.delivery === undefined
            ? { delivery: normalizeSessionDeliveryState() }
            : {}),
          // Stamp provenance only for genuinely new rows: adopting an existing key
          // must not restamp write-once node facts (this direct store write bypasses
          // the merge-level write-once guard), and legacy rows stay "unknown".
          ...(creation && createdNewEntry
            ? buildSessionCreationStamp({
                ...creation,
                // Delegated isolation survives changes to the creator's current role.
                sandbox: creation.sandbox ?? resolveCreatorSandbox(params.cfg, creation),
              })
            : {}),
          ...(createdNewEntry && inheritedSpawnOwner ? { owner: inheritedSpawnOwner } : {}),
          ...(params.visibility && createdNewEntry ? { visibility: params.visibility } : {}),
          ...projectPreparedSessionWorkspace(existingEntry, {
            projectId,
            pendingProjectGitUrl,
            pendingWorktree,
            spawnedCwd,
            preparedLifecycle,
          }),
          ...(catalogResolvedModel && catalogAgentRuntime
            ? {
                providerOverride: catalogResolvedModel.provider,
                modelOverride: catalogResolvedModel.model,
                modelOverrideSource: "user" as const,
                modelOverrideRouteResolution: "resolved" as const,
                agentRuntimeOverride: catalogAgentRuntime,
                modelSelectionLocked: true,
                pluginOwnerId: catalogPluginOwnerId,
              }
            : {}),
          ...(execNode ? { execHost: "node", execNode, ...(execCwd ? { execCwd } : {}) } : {}),
          ...(createdNewEntry && params.armSessionDiffBaselineCapture && !execNode
            ? {
                sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
              }
            : {}),
          ...(initialAgentHarnessId ? { agentHarnessId: initialAgentHarnessId } : {}),
          ...(initialColor ? { color: initialColor } : {}),
          ...(createdNewEntry && params.authorizedPluginId && !params.catalogTarget
            ? { pluginOwnerId: params.authorizedPluginId }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.providerOverride
            ? { providerOverride: params.initialEntry.providerOverride }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.modelOverride
            ? { modelOverride: params.initialEntry.modelOverride }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.modelOverrideRouteResolution
            ? { modelOverrideRouteResolution: params.initialEntry.modelOverrideRouteResolution }
            : {}),
          // Seeded CLI bindings ride only the plugin-authorized creation path;
          // harness creations must never smuggle pre-bound CLI session ids.
          ...(authorizedPluginCreation && params.initialEntry?.cliSessionBindings
            ? { cliSessionBindings: structuredClone(params.initialEntry.cliSessionBindings) }
            : {}),
          ...(params.initialEntry?.initializationPending === true
            ? { initializationPending: true }
            : {}),
          ...(params.atomicInitialization === true ? { initializationPending: true } : {}),
          ...(params.initialEntry?.modelSelectionLocked === true
            ? { modelSelectionLocked: true }
            : {}),
          ...(params.initialEntry?.pluginExtensions !== undefined
            ? { pluginExtensions: structuredClone(params.initialEntry.pluginExtensions) }
            : {}),
          // Spawn lineage is declared, never inferred: spawn-owned creations pass
          // spawnDepth explicitly; everything else (operator chats, forks, harness
          // and plugin sessions) persists as a depth-0 root. Reused entries keep
          // their stored depth.
          ...(existingEntry === undefined ? { spawnDepth: params.spawnDepth ?? 0 } : {}),
          ...(existingEntry === undefined && spawnToolPolicy
            ? {
                spawnedBy: spawnToolPolicy.parentSessionKey,
                ...(spawnToolPolicy.completionOwnerSessionKey
                  ? { completionOwnerSessionKey: spawnToolPolicy.completionOwnerSessionKey }
                  : {}),
                inheritedToolPolicyVersion: 1 as const,
                ...(spawnToolPolicy.allow.length > 0
                  ? { inheritedToolAllow: spawnToolPolicy.allow }
                  : {}),
                ...(spawnToolPolicy.deny.length > 0
                  ? { inheritedToolDeny: spawnToolPolicy.deny }
                  : {}),
              }
            : {}),
          ...(existingEntry === undefined && incognito ? { incognito: true as const } : {}),
        };
        const initialized = { ...patched, entry: initializedEntry };
        const explicitParentSessionKey =
          canonicalParentSessionKey ?? normalizeOptionalString(initializedEntry.parentSessionKey);
        const storedParentSessionKey = explicitParentSessionKey ?? dashboardParentSessionKey;
        const inheritedSelection =
          !canonicalParentSessionKey || catalogModel || normalizeOptionalString(params.model)
            ? {}
            : inheritSessionSelection(currentParentSessionEntry);
        if (requestedToolOverrides) {
          delete inheritedSelection.toolOverrides;
        }
        if (requestedFastMode !== undefined) {
          // The create-time choice belongs to the new session; parent inheritance must not
          // replace it after the canonical patch has validated and stored it.
          delete inheritedSelection.fastMode;
        }
        const entry: SessionEntry = {
          ...initializedEntry,
          ...inheritedSelection,
          // Main groups dashboard roots; it must not supply their reply-time model.
          ...(createdNewEntry &&
          dashboardParentSessionKey &&
          !explicitParentSessionKey &&
          !initializedEntry.modelOverride
            ? { modelOverrideSource: "default" as const }
            : {}),
          ...(storedParentSessionKey ? { parentSessionKey: storedParentSessionKey } : {}),
          ...(canonicalParentSessionKey && currentParentSessionEntry?.sessionId
            ? { parentSessionId: currentParentSessionEntry.sessionId }
            : {}),
        };
        let validateAccountModel: (() => ErrorShape | undefined) | undefined;
        if (params.fork !== true) {
          if (createdNewEntry && !entry.authProfileOverride && personalAccountDefaults) {
            const account = await prepareSessionCreateDefaultAccount({
              cfg: params.cfg,
              agentId: target.agentId,
              entry,
              defaults: personalAccountDefaults,
              operatorAuthority: params.operatorAuthority,
              resetToDefault: params.model === undefined && !params.catalogTarget,
              assertCurrent: commitGuard,
            });
            if (!account.ok) {
              return account;
            }
            validateAccountModel = account.validate;
            validateRuntimeSelection = account.validate;
            selectedDefaultProfile = account.profileId;
            commitGuard?.();
            if (account.profileId) {
              // Pin before the first turn; later default changes must not claim this session.
              entry.authProfileOverride = account.profileId;
              entry.authProfileOverrideSource = "user-link";
              delete entry.authProfileOverrideCompactionCount;
            }
          }
        }
        const runtimeSelection = await prepareSessionPatchRuntimeSelection({
          cfg: params.cfg,
          agentId: target.agentId,
          patch: {
            key: target.canonicalKey,
            agentRuntime: params.agentRuntime,
            model: params.model,
          },
          entry,
          catalog: preparedModelCatalog?.entries,
          validateModelSelection:
            validateAccountModel ?? patched.validateModelSelection ?? modelSelection.validate,
          ...(params.agentRuntime !== undefined || params.model !== undefined
            ? {
                placement: {
                  context: resolveSessionWorkerPlacementContext(),
                  sessionKey: target.canonicalKey,
                },
              }
            : {}),
        });
        if (!runtimeSelection.ok) {
          return runtimeSelection;
        }
        validateRuntimeSelection = runtimeSelection.validate;
        if (params.fork !== true) {
          return { ...initialized, entry };
        }
        const forkParentSessionKey = canonicalParentSessionKey;
        if (!forkParentSessionKey || !currentParentSessionEntry || !parentSessionTarget) {
          return {
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, "failed to resolve parent session for fork"),
          };
        }
        const forkMaxTokens = await resolveSessionForkMaxTokens({
          cfg: params.cfg,
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          entry,
          loadGatewayModelCatalogSnapshot: params.loadGatewayModelCatalogSnapshot,
        });
        // The storage owner selects one source for both size admission and copying,
        // so an active tail cannot make a smaller stable prefix fail the cap.
        const forkFromParent = async (assertSourceCurrent?: () => void) =>
          await forkSessionFromParentWithDecision({
            parentEntry: currentParentSessionEntry,
            agentId: parentSessionTarget.agentId,
            ...(commitGuard || assertSourceCurrent
              ? {
                  commitGuard: () => {
                    commitGuard?.();
                    assertSourceCurrent?.();
                  },
                }
              : {}),
            parentSessionKey: forkParentSessionKey,
            sessionKey: target.canonicalKey,
            storePath: parentSessionTarget.storePath,
            ...(forkMaxTokens ? { maxTokens: forkMaxTokens } : {}),
            // Keep the fork transcript owned by the child store across agent boundaries.
            targetStorePath: target.storePath,
            ...(params.forkFrom ? { forkFrom: params.forkFrom } : {}),
          });
        const forkResult = preparedLifecycle?.withCommit
          ? await preparedLifecycle.withCommit(forkFromParent)
          : await forkFromParent();
        if (forkResult.status === "too-large") {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `parent session is too large to fork (${forkResult.decision.parentTokens}/${forkResult.decision.maxTokens} tokens)`,
            ),
          };
        }
        if (forkResult.status !== "created") {
          return {
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, "failed to fork parent session transcript"),
          };
        }
        return {
          ...initialized,
          entry: buildForkedGatewaySessionEntry(
            entry,
            forkResult.transcript,
            {
              sessionKey: forkParentSessionKey,
              sessionId: currentParentSessionEntry.sessionId,
            },
            existingEntry,
          ),
        };
      },
      {
        ...(params.initialEntry
          ? {
              activeSessionKey: target.canonicalKey,
              requireWriteSuccess: true,
            }
          : {}),
        ...(commitGuard ? { commitGuard } : {}),
        ...(preparedLifecycle?.withCommit ? { withCommit: preparedLifecycle.withCommit } : {}),
        ...(inheritedSpawnOwner
          ? {
              resolveOwnerAssignment: () => (createdNewEntry ? inheritedSpawnOwner : undefined),
            }
          : {}),
        afterCommitted: params.afterSessionCommitted,
        onLifecycleCommitted: (entry) => {
          lifecyclePreparationCommitted = true;
          if (createdNewEntry) {
            params.onCreatedSessionCommitted?.({
              key: target.canonicalKey,
              agentId: target.agentId,
              storePath: target.storePath,
              entry,
              isNew: true,
            });
          }
        },
        ...(runtimeCwd ? { cwd: runtimeCwd } : {}),
      },
    );
    if (!created.ok) {
      return {
        ok: false,
        error:
          created.phase === "transcript"
            ? errorShape(
                ErrorCodes.UNAVAILABLE,
                `failed to create session transcript: ${created.error}`,
              )
            : created.error,
      };
    }
    createdContext = {
      key: target.canonicalKey,
      agentId: target.agentId,
      entry: projectPublicSessionEntry(created.entry),
      storePath: target.storePath,
      isNew: createdNewEntry,
    };
    if (!createdNewEntry && (params.agentRuntime !== undefined || params.model !== undefined)) {
      refreshSessionPatchQueuedSelection({
        cfg: params.cfg,
        entry: created.entry,
        patch: { key: target.canonicalKey, agentRuntime: params.agentRuntime, model: params.model },
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        catalog: preparedModelCatalog?.entries,
      });
    }
    if (createdNewEntry) {
      // The created fact belongs to this row generation; record it before a
      // same-key delete can acquire the lifecycle fence and purge that state.
      recordSessionCreated(params.cfg, {
        sessionKey: createdContext.key,
        agentId: createdContext.agentId,
        entry: createdContext.entry,
      });
    }

    if (canonicalParentSessionKey && parentSessionTarget && params.emitCommandHooks === true) {
      const parentEntry = currentParentSessionEntry;
      const { emitGatewaySessionEndPluginHook, emitGatewaySessionStartPluginHook } =
        await loadSessionLifecycleRuntime();
      // Child key shape does not establish lifecycle ownership. The caller owns
      // that fact; omission keeps the shipped rollover for out-of-tree clients.
      if (params.succeedsParent !== false) {
        emitGatewaySessionEndPluginHook({
          cfg: params.cfg,
          sessionKey: canonicalParentSessionKey,
          sessionId: parentEntry?.sessionId,
          storePath: parentSessionTarget.storePath,
          sessionFile: canonicalParentSessionKey,
          agentId: parentSessionTarget.agentId,
          reason: "new",
          nextSessionId: created.entry.sessionId,
          nextSessionKey: target.canonicalKey,
        });
      }
      emitGatewaySessionStartPluginHook({
        cfg: params.cfg,
        sessionKey: target.canonicalKey,
        sessionId: created.entry.sessionId,
        resumedFrom: parentEntry?.sessionId,
        storePath: target.storePath,
        sessionFile: target.canonicalKey,
        agentId: target.agentId,
      });
    }

    const selectedModel = resolveSessionModelRef(params.cfg, created.entry, target.agentId);

    return {
      ok: true,
      key: target.canonicalKey,
      agentId: target.agentId,
      entry: projectPublicSessionEntry(created.entry),
      resolved: {
        modelProvider: selectedModel.provider,
        model: selectedModel.model,
      },
      resetExisting: false,
    };
  };

  const targetLifecycleIdentities = [
    creationTarget.canonicalKey,
    ...creationTarget.storeKeys,
    ...(requestedKey ? [requestedKey] : []),
    ...(initialTargetEntry?.sessionId ? [initialTargetEntry.sessionId] : []),
  ];
  const lifecycleTargets = [
    {
      scope: creationTarget.storePath,
      identities: targetLifecycleIdentities,
    },
  ];
  if (
    canonicalParentSessionKey &&
    parentSessionEntry?.sessionId &&
    parentSessionTarget &&
    holdParentLifecycle
  ) {
    lifecycleTargets.push({
      scope: parentSessionTarget.storePath,
      identities: [canonicalParentSessionKey, parentSessionEntry.sessionId],
    });
  }
  // Generated, keyed, same-store, and cross-agent creations all share the
  // lifecycle owner's canonical identity order and one active mutation fence.
  const result = await runExclusiveSessionLifecycleMutation({
    targets: lifecycleTargets,
    run: createChildSession,
    finalize: async () => {
      if (!lifecyclePreparationCommitted) {
        await rollbackGatewaySessionPreparation({
          prepared: preparedLifecycle,
          onError: params.onLifecycleCleanupError,
        });
      }
    },
  });
  if (!result.ok) {
    return result;
  }
  if (params.atomicInitialization === true) {
    if (result.resetExisting || !createdContext || !params.afterCreate) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          "atomic session initialization did not create a session",
        ),
      };
    }
    const initializingSession = createdContext;
    const stored = loadGatewaySessionEntryReadOnly(initializingSession.key, {
      agentId: initializingSession.agentId,
    }).entry;
    if (
      !stored ||
      stored.sessionId !== initializingSession.entry.sessionId ||
      stored.initializationPending !== true
    ) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.UNAVAILABLE, "atomic session initialization lost its owner"),
      };
    }
    const expectedEntry = structuredClone(stored);
    try {
      await params.afterCreate(initializingSession);
      const finalized = await patchSessionEntryCore(
        { sessionKey: initializingSession.key, storePath: initializingSession.storePath },
        (current) => {
          if (!isDeepStrictEqual(current, expectedEntry)) {
            throw new Error(
              `created session ${initializingSession.key} changed before finalization`,
            );
          }
          return { initializationPending: undefined };
        },
        {
          preserveActivity: true,
          requireWriteSuccess: true,
          ...(params.commitGuard ? { assertCommitAllowed: params.commitGuard } : {}),
        },
      );
      if (!finalized) {
        throw new Error(
          `created session ${initializingSession.key} disappeared before finalization`,
        );
      }
      return {
        ...result,
        entry: projectPublicSessionEntry(finalized),
        postCommit: { status: "completed" },
      };
    } catch (error) {
      try {
        const rollback = await deleteSessionEntryLifecycle({
          agentId: initializingSession.agentId,
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
          expectedEntry,
          expectedSessionId: expectedEntry.sessionId,
          expectedUpdatedAt: expectedEntry.updatedAt,
          requireWriteSuccess: true,
          storePath: initializingSession.storePath,
          target: {
            canonicalKey: initializingSession.key,
            storeKeys: [initializingSession.key],
          },
        });
        if (!rollback.deleted) {
          throw new Error(`created session ${initializingSession.key} changed before rollback`, {
            cause: error,
          });
        }
      } catch (rollbackError) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `session initialization failed and rollback did not complete: ${formatErrorMessage(
              new AggregateError([error, rollbackError]),
            )}`,
          ),
        };
      }
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `session initialization failed: ${formatErrorMessage(error)}`,
        ),
      };
    }
  }
  if (result.resetExisting || !createdContext || !params.afterCreate) {
    return { ...result, postCommit: { status: "completed" } };
  }
  // The row, transcript, and prepared lifecycle are already durable here. A
  // fallible initializer must report that committed identity instead of making
  // callers infer that creation never happened and retry the key.
  try {
    await params.afterCreate(createdContext);
    return { ...result, postCommit: { status: "completed" } };
  } catch (error) {
    return { ...result, postCommit: { status: "failed", error } };
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
