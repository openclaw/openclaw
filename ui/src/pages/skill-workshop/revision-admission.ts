import {
  readSkillProposalRevisionChangedError,
  type SkillsProposalInspectResult,
} from "@openclaw/gateway-protocol";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type {
  SkillWorkshopRevisionAdmissionBinding,
  SkillWorkshopRevisionAdmissionEntry,
} from "../../app/skill-workshop-revision-admissions.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { ChatSendAck } from "../chat/chat-send-ack.ts";
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import { resolveSkillWorkshopRevisionTarget } from "./revision-session.ts";

export async function requestSkillWorkshopRevisionAdmission(params: {
  context: ApplicationContext;
  entry: SkillWorkshopRevisionAdmissionEntry;
  materialize: (
    binding: SkillWorkshopRevisionAdmissionBinding,
  ) => SkillWorkshopRevisionAdmissionEntry | null;
}) {
  const source = params.context.gateway.snapshot;
  const client = source.client;
  const createdAt = Date.now();
  if (!client) {
    throw new Error("Gateway is not connected.");
  }
  const isCurrent = () => {
    const current: ApplicationGatewaySnapshot = params.context.gateway.snapshot;
    return (
      current.phase === "connected" && current.client === client && current.hello === source.hello
    );
  };
  let entry = params.entry;
  if (!entry.expectedRevisionHash) {
    const result = await client.request<SkillsProposalInspectResult>("skills.proposals.inspect", {
      agentId: normalizeAgentId(entry.proposalAgentId),
      proposalId: entry.proposalId,
    });
    if (!isCurrent()) {
      throw new Error("Revision request was interrupted before proposal inspection completed.");
    }
    const expectedRevisionHash = result.revisionHash?.trim();
    if (!expectedRevisionHash) {
      throw new Error("The proposal revision binding is unavailable.");
    }
    const origin = result.record.origin;
    const materialized = params.materialize({
      expectedRevisionHash,
      ...(origin?.agentId ? { proposalOriginAgentId: origin.agentId } : {}),
      ...(origin?.sessionKey ? { proposalOriginSessionKey: origin.sessionKey } : {}),
    });
    if (!materialized) {
      throw new Error("Revision recovery is no longer available.");
    }
    entry = materialized;
  }
  if (!entry.expectedRevisionHash) {
    throw new Error("Revision recovery is no longer available.");
  }
  const target = await resolveSkillWorkshopRevisionTarget(entry, params.context, isCurrent);
  if (!target) {
    throw new Error("Revision request was interrupted before admission.");
  }
  const result = await client
    .request<ChatSendAck>("skills.proposals.requestRevision", {
      agentId: normalizeAgentId(entry.proposalOriginAgentId ?? entry.proposalAgentId),
      targetAgentId: target.targetAgentId,
      proposalId: entry.proposalId,
      expectedRevisionHash: entry.expectedRevisionHash,
      instructions: entry.instructions,
      sessionKey: target.sessionKey,
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      idempotencyKey: entry.idempotencyKey,
    })
    .catch((error: unknown) => {
      if (readSkillProposalRevisionChangedError(error)) {
        return { status: "revision-changed" as const };
      }
      throw error;
    });
  if (result.status === "revision-changed") {
    return result;
  }
  if (result.status !== "started" && result.status !== "in_flight" && result.status !== "ok") {
    throw new Error(`Gateway returned ${result.status} before admitting the revision request.`);
  }
  // Transfer display custody before the admission owner retires the saved instructions.
  if (isCurrent()) {
    params.context.chatSubmissions.retain(
      buildInitialChatSubmission(
        target.sessionKey,
        { text: entry.instructions, createdAt },
        client,
        result.runId,
      ),
    );
  }
  return { sessionKey: target.sessionKey, status: "admitted" as const };
}
