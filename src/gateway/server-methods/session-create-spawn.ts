import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { createGatewaySession } from "../session-create-service.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/**
 * A spawn-owned visible child exists only to run its initial task, so the
 * creating request removes it when that task never started. The delete is
 * fenced to the exact incarnation this request committed and runs under the
 * create request's own session authority, so a write-only caller does not
 * strand a child it could create but not delete, and a caller whose authority
 * closed keeps the child for recovery.
 */
export async function rollBackUnstartedSpawnChild(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  assertCurrent: () => void;
  key: string;
  agentId: string;
  sessionId: string;
  lifecycleRevision?: string;
}): Promise<boolean> {
  const { deleteGatewaySession } = await import("./sessions-delete.js");
  const result = await deleteGatewaySession({
    params: {
      key: params.key,
      agentId: params.agentId,
      deleteTranscript: true,
      emitLifecycleHooks: false,
      expectedSessionId: params.sessionId,
      ...(params.lifecycleRevision ? { expectedLifecycleRevision: params.lifecycleRevision } : {}),
    },
    client: params.client,
    context: params.context,
    assertCurrent: params.assertCurrent,
  }).catch((error: unknown) => ({
    ok: false as const,
    error: { message: formatErrorMessage(error) },
  }));
  if (!result.ok) {
    sessionLog.warn(`unstarted spawn child ${params.key} kept: ${result.error.message}`);
    return false;
  }
  return result.result.deleted;
}

export function resolveSessionCreateSpawnContext(params: {
  client: GatewayClient | null;
  creation: TrustedSessionCreation;
  agentId?: string;
  model?: string;
  parentSessionKey?: string;
  fork?: boolean;
  forkFrom?: "last-completed";
  emitCommandHooks?: boolean;
  assertRuntimeCurrent?: () => void;
}): Pick<
  Parameters<typeof createGatewaySession>[0],
  "spawnToolPolicy" | "activeParentFork" | "preparedModelSelection" | "preparedPermissionSelection"
> {
  const spawnToolPolicy =
    params.creation.via === "spawn" && params.creation.inheritedToolPolicy
      ? {
          ...params.creation.inheritedToolPolicy,
          ...(params.creation.completionOwnerSessionKey
            ? { completionOwnerSessionKey: params.creation.completionOwnerSessionKey }
            : {}),
        }
      : undefined;
  if (
    params.creation.via !== "spawn" ||
    !params.creation.inheritedToolPolicy ||
    params.creation.actor?.type !== "agent"
  ) {
    if (params.creation.inheritedPermissionMode) {
      throw new Error("Permission inheritance requires a trusted spawn requester.");
    }
    if (params.creation.resolvedModel) {
      throw new Error("Resolved model inheritance requires a trusted spawn requester.");
    }
    return { spawnToolPolicy };
  }
  const toolCaller = params.client?.internal?.agentToolCaller;
  const runtimeIdentity = params.client?.internal?.agentRuntimeIdentity;
  const requester = toolCaller?.assertCurrent
    ? {
        agentId: toolCaller.agentId,
        sessionKey: toolCaller.sessionKey,
        assertCurrent: toolCaller.assertCurrent,
      }
    : runtimeIdentity && params.assertRuntimeCurrent
      ? {
          agentId: runtimeIdentity.agentId,
          sessionKey: runtimeIdentity.sessionKey,
          assertCurrent: params.assertRuntimeCurrent,
        }
      : undefined;
  const requesterSessionKey = normalizeOptionalString(params.creation.requesterSessionKey);
  if (
    !requester ||
    requester.sessionKey !== requesterSessionKey ||
    requesterSessionKey !== params.parentSessionKey ||
    normalizeAgentId(params.creation.actor.id) !== normalizeAgentId(requester.agentId)
  ) {
    if (params.creation.inheritedPermissionMode) {
      throw new Error("Permission inheritance requires a current matching spawn requester.");
    }
    if (params.creation.resolvedModel) {
      throw new Error("Resolved model inheritance requires a current same-agent requester.");
    }
    return { spawnToolPolicy };
  }
  // Permission policy belongs to the live caller even for a different target
  // agent. Model inheritance and active transcript forks still require the same agent.
  const preparedPermissionSelection = params.creation.inheritedPermissionMode
    ? { mode: params.creation.inheritedPermissionMode, assertCurrent: requester.assertCurrent }
    : undefined;
  if (normalizeAgentId(requester.agentId) !== params.agentId) {
    if (params.creation.resolvedModel) {
      throw new Error("Resolved model inheritance requires a current same-agent requester.");
    }
    return { spawnToolPolicy, preparedPermissionSelection };
  }
  const resolvedModel = params.creation.resolvedModel;
  if (resolvedModel && params.model !== `${resolvedModel.provider}/${resolvedModel.model}`) {
    throw new Error("Resolved spawn model does not match the requested model.");
  }
  const preparedModelSelection = resolvedModel
    ? { ref: { ...resolvedModel }, assertCurrent: requester.assertCurrent }
    : undefined;
  if (params.fork !== true || params.forkFrom !== undefined || params.emitCommandHooks === true) {
    return { spawnToolPolicy, preparedModelSelection, preparedPermissionSelection };
  }
  return {
    spawnToolPolicy,
    preparedModelSelection,
    preparedPermissionSelection,
    activeParentFork: {
      requesterSessionKey: requester.sessionKey,
      assertCurrent: requester.assertCurrent,
    },
  };
}
