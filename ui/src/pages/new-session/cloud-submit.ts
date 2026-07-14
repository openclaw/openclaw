import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { writeCloudSessionRecovery } from "./cloud-recovery.ts";
import {
  deleteCloudDraftSession,
  deleteRecoveredCloudDraftSession,
  startCloudInitialTurn,
} from "./cloud-target.ts";

export type CloudDraftAdvanceResult =
  | { status: "started"; messageId: string }
  | { status: "send-rejected"; error: string; messageId: string }
  | { status: "cleanup-rejected"; error: string; messageId?: string }
  | { status: "dispatch-rejected"; error: string }
  | { status: "cancelled"; cleanupError?: string; recoveryPersisted: boolean }
  | { status: "ownership-lost" };

export async function advanceCloudDraftSession(params: {
  client: Pick<GatewayBrowserClient, "request">;
  key: string;
  agentId: string;
  profileId: string;
  message: string;
  attachments?: unknown[];
  messageId: string;
  gatewayUrl: string;
  recoveryScope: string;
  recovering: boolean;
  isCurrent: () => boolean;
  ownsRecovery: () => boolean;
  clearRecovery: () => void;
}): Promise<CloudDraftAdvanceResult> {
  if (!params.isCurrent()) {
    const cleanupError = params.recovering
      ? await deleteRecoveredCloudDraftSession(params.client, params.key, params.agentId)
      : await deleteCloudDraftSession(params.client, params.key, params.agentId);
    return { status: "cancelled", cleanupError, recoveryPersisted: false };
  }
  const recoveryPersisted = writeCloudSessionRecovery({
    sessionKey: params.key,
    messageId: params.messageId,
    message: params.message,
    attachments: params.attachments,
    profileId: params.profileId,
    agentId: params.agentId,
    gatewayUrl: params.gatewayUrl,
    recoveryScope: params.recoveryScope,
  });
  if (!params.isCurrent() || !recoveryPersisted) {
    const cleanupError = params.recovering
      ? await deleteRecoveredCloudDraftSession(params.client, params.key, params.agentId)
      : await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery();
    }
    return { status: "cancelled", cleanupError, recoveryPersisted };
  }

  const cloudStart = await startCloudInitialTurn(
    params.client,
    {
      key: params.key,
      agentId: params.agentId,
      profileId: params.profileId,
      message: params.message,
      attachments: params.attachments,
      messageId: params.messageId,
      recovering: params.recovering,
    },
    params.isCurrent,
  );
  if (cloudStart.status === "cancelled") {
    const cleanupError = await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery();
    }
    return { status: "cancelled", cleanupError, recoveryPersisted: true };
  }
  if (cloudStart.status === "cleanup-rejected") {
    return cloudStart;
  }
  if (cloudStart.status === "dispatch-rejected") {
    if (params.recovering) {
      // The previous send may have been accepted before this recovered worker
      // became terminal. Keep its transcript and idempotency key recoverable.
      return {
        status: "send-rejected",
        error: cloudStart.error,
        messageId: params.messageId,
      };
    }
    const cleanupError = await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery();
    }
    return {
      status: "dispatch-rejected",
      error: cleanupError || cloudStart.error,
    };
  }
  if (cloudStart.status === "send-rejected") {
    return cloudStart;
  }
  if (!params.isCurrent() || !params.ownsRecovery()) {
    // The worker is active, but ownership changed after the helper's final
    // check. Keep recovery durable instead of orphaning it.
    return { status: "ownership-lost" };
  }
  params.clearRecovery();
  return cloudStart;
}
