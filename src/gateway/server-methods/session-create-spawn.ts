import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { executionIdentitySpawnAdmission } from "../../audit/execution-identity-spawn-admission.js";
import { reportCreatedVisibleWorkSession } from "../../auto-reply/reply/visible-work-sessions.js";
import { resolveControlUiSessionUrl } from "../../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { captureAgentTurnPrincipal } from "../agent-turn/principal.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayAgentToolIngress,
} from "../local-user-ingress.js";
import type { createGatewaySession } from "../session-create-service.js";
import type { CreatedGatewaySession } from "../session-create-service.types.js";
import type { TrustedSessionCreation } from "../session-creation-provenance.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/** Opening input keeps its selected person while recording the agent that actually sent it. */
export function prepareSessionCreateOpening(params: {
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">;
  creation: TrustedSessionCreation;
  session: CreatedGatewaySession;
  agentCreated: boolean;
  sourceAccepted: boolean;
  assertCurrent: () => void;
}) {
  const { client, creation, session } = params;
  const toolCaller = client?.internal?.agentToolCaller;
  const runtime = client?.internal?.agentRuntimeIdentity;
  const caller = toolCaller?.assertCurrent
    ? toolCaller
    : runtime && params.context.validateAgentRuntimeApprovalAuthority?.(runtime) === true
      ? {
          agentId: runtime.agentId,
          sessionKey: runtime.sessionKey,
          executionIdentityToken: runtime.executionIdentity,
          assertCurrent: params.assertCurrent,
        }
      : undefined;
  const spawn =
    creation.via === "spawn" &&
    creation.actor?.type === "agent" &&
    caller?.agentId === normalizeAgentId(creation.actor.id) &&
    caller.sessionKey === creation.requesterSessionKey;
  const agentOpening = caller && (params.agentCreated || spawn);
  const principal =
    params.sourceAccepted || agentOpening ? captureAgentTurnPrincipal(client) : client;
  if (!agentOpening || !principal) {
    return { client: principal };
  }
  params.assertCurrent();
  caller.assertCurrent?.();
  const parent = caller.executionIdentityToken;
  const depth = session.entry.spawnDepth;
  const spawnAdmission =
    spawn && session.entry.parentSessionKey === caller.sessionKey && depth && depth > 0
      ? executionIdentitySpawnAdmission({
          operation: "serialize",
          value: {
            ...(parent?.contextId ? { parentContextId: parent.contextId } : {}),
            ...(parent?.executionId ? { parentExecutionId: parent.executionId } : {}),
            ...(parent?.runId ? { parentRunId: parent.runId } : {}),
            parentAgentId: caller.agentId,
            relation: "sessions_spawn",
            rawRequesterRef: caller.sessionKey,
            rawControllerRef: caller.sessionKey,
            depth,
            localPolicyRefs: [],
            targetPolicyRefs: [],
          },
          extra: [
            ...(!parent?.contextId ? ["lineage.parent-context"] : []),
            ...(!parent?.executionId ? ["lineage.parent-execution"] : []),
            ...(!parent?.runId ? ["lineage.parent-run"] : []),
            "lineage.local-policy",
            "lineage.target-policy",
          ],
        })
      : undefined;
  attachGatewayLocalUserIngress(
    principal,
    prepareGatewayAgentToolIngress({
      agentId: caller.agentId,
      representedProfileId: client?.internal?.operatorRunAuthority?.profileId,
      spawnAdmission,
    }),
  );
  // Creator/access identity stays with the person; their agent wrote the opening message.
  principal.internal = {
    ...principal.internal,
    senderAttribution: { id: "agent:" + caller.agentId },
  };
  return {
    client: principal,
    internalInput: {
      systemInputProvenance: {
        kind: "inter_session" as const,
        sourceSessionKey: creation.requesterSessionKey,
        sourceTool: spawn ? "sessions_spawn" : "sessions_create",
      },
      suppressCommandInterpretation: true,
    },
  };
}

export async function reportCreatedVisibleSpawn(
  cfg: OpenClawConfig,
  creation: TrustedSessionCreation,
  session: CreatedGatewaySession,
  publicRead: boolean,
): Promise<void> {
  const parentSessionKey = session.entry.parentSessionKey;
  if (
    creation.via !== "spawn" ||
    creation.requesterSessionKey !== parentSessionKey ||
    !parentSessionKey ||
    session.entry.visibility === "draft" ||
    session.entry.incognito
  ) {
    return;
  }
  const url = resolveControlUiSessionUrl(cfg, {
    sessionKey: session.key,
    fallbackAgentId: session.agentId,
  });
  await reportCreatedVisibleWorkSession({
    requesterSessionKey: parentSessionKey,
    sessionKey: session.key,
    ...(url
      ? {
          visibleSession: {
            url,
            ...(publicRead ? { publicRead: true } : {}),
            ...(session.entry.label ? { label: session.entry.label } : {}),
          },
        }
      : {}),
  });
}

export function validateSessionCreateSpawnRequest(
  creation: TrustedSessionCreation,
  params: Pick<
    SessionsCreateParams,
    "parentSessionKey" | "fork" | "forkFrom" | "incognito" | "visibility"
  >,
) {
  const parent = normalizeOptionalString(params.parentSessionKey);
  const requester =
    creation.via === "spawn" ? normalizeOptionalString(creation.requesterSessionKey) : undefined;
  if (creation.inheritedToolPolicy && parent !== requester) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "spawn parent must match the trusted agent caller",
    );
  }
  if (
    creation.childSessionPublication &&
    (creation.via !== "spawn" ||
      requester !== parent ||
      creation.childSessionPublication.requesterSessionKey !== parent ||
      params.fork === true ||
      params.forkFrom !== undefined ||
      params.incognito === true ||
      params.visibility === "draft")
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Public ingress requires a fresh isolated, non-private child.",
    );
  }
  return undefined;
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
        agentId: normalizeAgentId(toolCaller.agentId),
        sessionKey: toolCaller.sessionKey,
        assertCurrent: toolCaller.assertCurrent,
      }
    : runtimeIdentity && params.assertRuntimeCurrent
      ? {
          agentId: normalizeAgentId(runtimeIdentity.agentId),
          sessionKey: runtimeIdentity.sessionKey,
          assertCurrent: params.assertRuntimeCurrent,
        }
      : undefined;
  const requesterSessionKey = normalizeOptionalString(params.creation.requesterSessionKey);
  if (
    !requester ||
    requester.sessionKey !== requesterSessionKey ||
    requesterSessionKey !== params.parentSessionKey ||
    normalizeAgentId(params.creation.actor.id) !== requester.agentId
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
  if (requester.agentId !== params.agentId) {
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
