import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { createGatewaySession } from "../session-create-service.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";
import type { GatewayClient } from "./types.js";

export function resolveSessionCreateSpawnContext(params: {
  client: GatewayClient | null;
  creation: TrustedSessionCreation;
  agentId?: string;
  parentSessionKey?: string;
  fork?: boolean;
  forkFrom?: "last-completed";
  emitCommandHooks?: boolean;
  assertRuntimeCurrent?: () => void;
}): Pick<Parameters<typeof createGatewaySession>[0], "spawnToolPolicy" | "activeParentFork"> {
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
    params.fork !== true ||
    params.forkFrom !== undefined ||
    params.emitCommandHooks === true ||
    params.creation.via !== "spawn" ||
    !params.creation.inheritedToolPolicy ||
    params.creation.actor?.type !== "agent"
  ) {
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
    normalizeAgentId(requester.agentId) !== params.agentId ||
    normalizeAgentId(params.creation.actor.id) !== params.agentId
  ) {
    return { spawnToolPolicy };
  }
  return {
    spawnToolPolicy,
    activeParentFork: {
      requesterSessionKey: requester.sessionKey,
      assertCurrent: requester.assertCurrent,
    },
  };
}
