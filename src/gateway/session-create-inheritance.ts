import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../agents/inherited-tool-deny.js";
import { MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE } from "../auto-reply/reply/session-fork.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import {
  inheritSessionCreationPolicy,
  inheritSessionGitContributorProfileIds,
  inheritSpawnSessionOwner,
  type SessionOwnerAssignment,
} from "../config/sessions/session-entry-provenance.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { waitForSessionParticipantRecording } from "../sessions/session-participant-recording.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest } from "./session-request-error.js";
import {
  loadGatewaySessionEntryReadOnlyInWorker,
  resolveGatewaySessionStoreTargetInWorker,
} from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

type SessionCreation = NonNullable<CreateGatewaySessionParams["creation"]> &
  Pick<SessionEntry, "inheritedGitContributorProfileIds">;

/** Inherit parent selection without replacing explicitly requested choices. */
export function inheritSessionCreateParentFields(params: {
  parent: SessionEntry | undefined;
  newExplicitChild: boolean;
  newDashboardRoot: boolean;
  selectedModel?: string;
  overrides: Pick<
    CreateGatewaySessionParams,
    "catalogTarget" | "model" | "toolOverrides" | "fastMode" | "communication"
  >;
}): Partial<InternalSessionEntry> {
  const { parent, overrides } = params;
  const inherited =
    overrides.catalogTarget?.model.trim() || overrides.model?.trim()
      ? {}
      : inheritSessionSelection(parent);
  if (overrides.toolOverrides !== undefined) {
    delete inherited.toolOverrides;
  }
  if (overrides.fastMode !== undefined) {
    // Explicit choices have already been validated by the canonical patch owner.
    delete inherited.fastMode;
  }
  // Communication inheritance initializes only a new explicit child. Adopting a
  // key or automatically grouping a dashboard root cannot replace its policy.
  if (params.newExplicitChild && overrides.communication === undefined && parent?.communication) {
    inherited.communication = { ...parent.communication };
  }
  // Main groups dashboard roots; it must not supply their reply-time model.
  if (params.newDashboardRoot && !params.selectedModel) {
    inherited.modelOverrideSource = "default";
  }
  return inherited;
}

/** Prepare the parent before lifecycle custody, while accepted input can still settle. */
export async function prepareSessionCreateParent(input: {
  params: Pick<CreateGatewaySessionParams, "cfg" | "creation" | "fork" | "authorizedPluginId">;
  key: string;
  agentId?: string;
  assertCurrent?: () => void;
}) {
  const ambient = isIncognitoSessionKey(input.key) ? captureIncognitoSessionSource() : undefined;
  let source = ambient;
  let retained: Awaited<ReturnType<typeof captureOpenClawAgentDatabaseExecution>>;
  let finishSource: (() => void) | undefined;
  let sourceSettlement: Promise<void> | undefined;
  let handedOff = false;
  let assertParentCurrent: SessionSourceAssertion | undefined;
  const assertAmbientCurrent = () => {
    ambient?.admissionSignal?.throwIfAborted();
    if (ambient && "kind" in ambient) {
      ambient.assertCurrent();
    } else {
      ambient?.actor.assertReadable();
    }
  };
  const assertSourceCurrent = () => {
    assertAmbientCurrent();
    if (source && "kind" in source) {
      source.assertCurrent();
    } else {
      source?.actor.assertReadable();
    }
    assertParentCurrent?.();
  };
  const assertCurrent = () => {
    input.assertCurrent?.();
    assertSourceCurrent();
  };
  const release = async () => {
    finishSource?.();
    try {
      await sourceSettlement;
    } finally {
      await retained?.release();
    }
  };
  try {
    const agentId = input.agentId ?? resolveAgentIdFromSessionKey(input.key);
    if (ambient && agentId !== ("kind" in ambient ? ambient.agentId : ambient.actor.agentId)) {
      const env =
        "kind" in ambient
          ? ambient.env
          : { OPENCLAW_STATE_DIR: path.resolve(ambient.actor.path, "../../../..") };
      // Cross-agent inheritance may borrow an existing parent, never create one on a miss.
      const selected = captureOpenClawAgentDatabaseExecution
        .listIncognito(env)
        .find((actor) => actor.agentId === agentId);
      if (!selected) {
        return invalidSessionRequest(`unknown parent session: ${input.key}`);
      }
      retained = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId,
        env,
        // The borrow's authority cannot depend on the source it is creating.
        // Current request and exact parent predicates run at every consuming boundary.
        authority: { assertCurrent: assertAmbientCurrent },
        existingOnly: true,
        signal: ambient.admissionSignal,
      });
      selected.assertCurrent();
      if (!retained || retained.identity.incarnation !== selected.identity.incarnation) {
        throw new Error("Parent session actor changed during creation preparation");
      }
      source = { actor: retained, admissionSignal: ambient.admissionSignal };
    }
    if (source && !("kind" in source)) {
      const finished = createDeferredCore();
      finishSource = finished.resolve;
      sourceSettlement = source.actor.sessions.withSharedState(() => finished.promise);
      void sourceSettlement.catch(() => {});
    }
    const run = <T>(operation: () => T): T =>
      source
        ? withIncognitoSessionBinding(
            "kind" in source
              ? { ...source, authority: { assertCurrent: source.assertCurrent } }
              : source,
            operation,
          )
        : operation();
    const target = await run(() =>
      resolveGatewaySessionStoreTargetInWorker({
        cfg: input.params.cfg,
        key: input.key,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        assertActive: assertCurrent,
      }),
    );
    if (source && !("kind" in source)) {
      assertParentCurrent = source.actor.sessions.captureCurrent(target.canonicalKey).assertCurrent;
    }
    if (input.params.creation?.via === "spawn") {
      await waitForSessionParticipantRecording({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      });
      assertCurrent();
    }
    const readCurrent = async () => {
      const parent = source
        ? await run(() =>
            loadGatewaySessionEntryReadOnlyInWorker({
              cfg: input.params.cfg,
              key: target.canonicalKey,
              agentId: target.agentId,
              assertActive: assertCurrent,
            }),
          )
        : loadGatewaySessionEntryReadOnly(input.key, { agentId: input.agentId });
      assertCurrent();
      return parent.entry;
    };
    const entry = await readCurrent();
    if (!entry?.sessionId) {
      return invalidSessionRequest(`unknown parent session: ${input.key}`);
    }
    const ownershipError = resolvePluginSessionOwnershipError({
      action: input.params.fork === true ? "fork" : "link",
      entry,
      key: target.canonicalKey,
      pluginOwnerId: input.params.authorizedPluginId,
    });
    if (ownershipError) {
      return { ok: false as const, error: ownershipError };
    }
    if (isModelSelectionLocked(entry)) {
      return invalidSessionRequest(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
    }
    if (source && !("kind" in source)) {
      const assertGenerationCurrent = assertParentCurrent;
      assertParentCurrent = run(() =>
        captureSessionEntrySourceAssertion({
          scope: {
            agentId: target.agentId,
            sessionKey: target.canonicalKey,
            storePath: target.storePath,
          },
          expected: entry,
          fields: [
            "sessionId",
            "lifecycleRevision",
            "pluginOwnerId",
            "modelSelectionLocked",
            "createdActor",
            "owner",
            "sandbox",
            "skillLibrarySelections",
            "communication",
            "providerOverride",
            "modelOverride",
            "modelOverrideSource",
            "modelOverrideRouteResolution",
            "modelOverrideFallbackOriginProvider",
            "modelOverrideFallbackOriginModel",
            "agentRuntimeOverride",
            "authProfileOverride",
            "authProfileOverrideSource",
            "authProfileOverrideCompactionCount",
            "contextWindow",
            "thinkingLevel",
            "fastMode",
            "toolOverrides",
            "verboseLevel",
            "traceLevel",
            "reasoningLevel",
            "elevatedLevel",
            "worktree",
            "repositoryWorkspaceId",
            "execHost",
            "execNode",
            "pendingWorktree",
            "pendingProjectGitUrl",
            "spawnedCwd",
            "spawnedWorkspaceDir",
            "sessionRoot",
            "projectId",
          ],
          assertCurrent: () => assertGenerationCurrent?.(),
          refuse() {
            throw new Error("Parent session changed before child creation; retry.");
          },
        }),
      );
    }
    handedOff = true;
    return {
      ok: true as const,
      entry,
      canonicalKey: target.canonicalKey,
      target,
      // A child worker can validate a parent row only within its own actor.
      assertCurrent:
        source === ambient
          ? composeSessionSourceAssertion([assertParentCurrent], (assertParent) => {
              assertAmbientCurrent();
              assertParent();
            })
          : assertSourceCurrent,
      readCurrent,
      release,
    };
  } finally {
    if (!handedOff) {
      await release();
    }
  }
}

function resolveResidentProfileId(profileId: string): string | undefined {
  try {
    return readResidentUserProfileId(profileId);
  } catch {
    // Catalog readiness never expands ownership: unresolved aliases fall back to the agent.
    return undefined;
  }
}

/** Derives trusted child policy and ownership from the locked spawn parent. */
export function resolveSessionCreateInheritance(params: {
  creation: SessionCreation | undefined;
  parent: SessionEntry | undefined;
}): {
  creation: SessionCreation | undefined;
  ownerAssignment?: SessionOwnerAssignment;
} {
  if (params.creation?.via !== "spawn") {
    return { creation: params.creation };
  }
  const ownerAssignment = inheritSpawnSessionOwner(
    params.parent,
    params.creation.actor,
    params.creation.requesterProfileId,
    Date.now(),
    resolveResidentProfileId,
  );
  return {
    creation: {
      ...params.creation,
      ...inheritSessionCreationPolicy(params.parent, params.creation.actor),
      inheritedGitContributorProfileIds: inheritSessionGitContributorProfileIds(params.parent),
    },
    ...(ownerAssignment ? { ownerAssignment } : {}),
  };
}

/** Project the trusted spawn policy only onto a genuinely new child row. */
export function resolveSessionCreateSpawnPolicy(
  params: Pick<CreateGatewaySessionParams, "spawnToolPolicy" | "preparedPermissionSelection">,
  parentSessionKey: string | undefined,
): Partial<SessionEntry> | undefined {
  if (!params.spawnToolPolicy || !parentSessionKey) {
    return undefined;
  }
  const completionOwnerSessionKey = normalizeOptionalString(
    params.spawnToolPolicy.completionOwnerSessionKey,
  );
  const allow = normalizeInheritedToolAllowlist(params.spawnToolPolicy.allow);
  const deny = normalizeInheritedToolDenylist(params.spawnToolPolicy.deny);
  return {
    spawnedBy: parentSessionKey,
    ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
    inheritedToolPolicyVersion: 1,
    ...(params.spawnToolPolicy.delegatedToolPolicy
      ? { delegatedToolPolicy: params.spawnToolPolicy.delegatedToolPolicy }
      : {}),
    ...(params.preparedPermissionSelection
      ? { permissionMode: params.preparedPermissionSelection.mode }
      : {}),
    ...(allow.length > 0 ? { inheritedToolAllow: allow } : {}),
    ...(deny.length > 0 ? { inheritedToolDeny: deny } : {}),
  };
}
