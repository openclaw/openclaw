import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { captureActiveEmbeddedRunParticipation } from "../agents/embedded-agent-runner/run-state.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import { captureSessionEntryView } from "../config/sessions/session-entry-view.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import {
  getResidentUserProfileDisplay,
  readResidentUserProfileId,
} from "../state/user-profile-list.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "./exec-approval-manager.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

/** Wire run/session/security fields and assigned owners cannot mint this binding. */
export async function prepareExecApprovalParticipation(
  identity: AgentRuntimeIdentity | undefined,
  cfg: OpenClawConfig,
): Promise<ExecApprovalRecord["participation"]> {
  const captured = identity && captureActiveEmbeddedRunParticipation(identity);
  if (!captured || !identity) {
    return undefined;
  }
  const read = await prepareSessionMutationFacts({
    cfg,
    agentId: identity.agentId,
    sessionKey: captured.ceiling.sessionKey,
  });
  try {
    captured.assertCurrent();
    const target = read.readCurrent(cfg).target;
    if (
      !target ||
      target.canonicalKey !== captured.ceiling.sessionKey ||
      !captureSessionEntryView(
        captured.ceiling.source ?? { sessionId: captured.sessionId },
        captured.ceiling.source ? ["sessionId", "lifecycleRevision"] : ["sessionId"],
      ).matches(target.entry) ||
      (captured.ceiling.source &&
        sessionCreatorProfileId(target.entry.createdActor) !==
          captured.ceiling.source.creatorProfileId)
    ) {
      throw new Error("Participation approval session owner changed");
    }
    const participantId = readResidentUserProfileId(captured.ceiling.profileId);
    return Object.freeze({
      creatorProfileId: sessionCreatorProfileId(target.entry.createdActor),
      ...(identity.sessionKey !== captured.ceiling.sessionKey
        ? { creatorOnly: true as const }
        : {}),
      participantProfileId: captured.ceiling.profileId,
      participantLabel:
        (participantId ? getResidentUserProfileDisplay(participantId).displayName : undefined) ||
        captured.ceiling.profileId,
      sessionKey: captured.ceiling.sessionKey,
    });
  } finally {
    read.release();
  }
}

/** Direct participation permits creator/admin; descendant execution requires its original creator. */
export function canResolveParticipationExecApproval(
  record: Pick<ExecApprovalRecord, "participation"> | null | undefined,
  client: GatewayClient | null | undefined,
): boolean | undefined {
  const binding = record?.participation;
  if (!binding) {
    return undefined;
  }
  if (!client || client.invalidated) {
    return false;
  }
  if (!binding.creatorOnly && client.connect.scopes?.includes(ADMIN_SCOPE)) {
    return true;
  }
  const profileId = client.authenticatedUserProfile?.profileId;
  if (
    !profileId ||
    client.internal?.agentRuntimeIdentity ||
    client.internal?.approvalRuntime ||
    client.internal?.syntheticClient
  ) {
    return false;
  }
  const matchesProfile = prepareSessionCreatorProfile(profileId);
  const matches = (id: string | undefined) =>
    matchesProfile(id ? { type: "human", source: "profile", id } : undefined);
  return !matches(binding.participantProfileId) && matches(binding.creatorProfileId);
}

/** Narrow alternative for method admission; no prefixes, durable lookup, or source inference. */
export function authorizeParticipationExecApprovalMethod(params: {
  method: string;
  params: unknown;
  client: GatewayClient | null | undefined;
  manager: Pick<ExecApprovalManager, "getLiveSnapshot"> | undefined;
}): boolean | undefined {
  if (params.method === "exec.approval.request" || params.method === "exec.approval.waitDecision") {
    const identity = params.client?.internal?.agentRuntimeIdentity;
    const captured = identity && captureActiveEmbeddedRunParticipation(identity);
    if (!captured || !identity || params.client?.invalidated) {
      return undefined;
    }
    if (params.method === "exec.approval.request") {
      return true;
    }
    const record =
      isRecord(params.params) && typeof params.params.id === "string"
        ? params.manager?.getLiveSnapshot(params.params.id)
        : undefined;
    // Waiting consumes only this retained tool owner's request, never another approval.
    return record &&
      record.participation &&
      record.participation.participantProfileId === captured.ceiling.profileId &&
      record.participation.sessionKey === captured.ceiling.sessionKey &&
      record.agentRuntimeDelegatedAuthority &&
      validateAgentRunDelegatedAuthority(
        record.agentRuntimeDelegatedAuthority,
        identity.delegatedAuthority,
      )
      ? true
      : undefined;
  }
  if (params.method !== "exec.approval.resolve" && params.method !== "approval.resolve") {
    return undefined;
  }
  if (
    !isRecord(params.params) ||
    typeof params.params.id !== "string" ||
    (params.method === "approval.resolve" &&
      params.params.kind !== undefined &&
      params.params.kind !== "exec")
  ) {
    return undefined;
  }
  return canResolveParticipationExecApproval(
    params.manager?.getLiveSnapshot(params.params.id),
    params.client,
  );
}

/** The initiating person can observe waiting status, never the command or reviewer decisions. */
export function canObserveParticipationExecApproval(
  record: Pick<ExecApprovalRecord, "participation"> | undefined,
  client: GatewayClient | null | undefined,
): boolean {
  const binding = record?.participation;
  return Boolean(
    binding &&
    client &&
    !client.invalidated &&
    (client.connect.role ?? "operator") === "operator" &&
    !client.internal?.agentRuntimeIdentity &&
    !client.internal?.approvalRuntime &&
    !client.internal?.syntheticClient &&
    prepareSessionCreatorProfile(client.authenticatedUserProfile?.profileId)({
      type: "human",
      source: "profile",
      id: binding.participantProfileId,
    }),
  );
}

export function participationApprovalTurnActor(
  record: Pick<ExecApprovalRecord<unknown>, "participation"> | null | undefined,
) {
  const binding = record?.participation;
  return binding
    ? {
        id: binding.participantProfileId,
        label: binding.participantLabel || binding.participantProfileId,
      }
    : undefined;
}
