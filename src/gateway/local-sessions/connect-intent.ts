// A profile-minted connect link carries a sharing intent; when the laptop that
// redeemed it finishes pairing, the intent becomes that profile's enrollments so
// the person never has to visit the Devices page or answer a separate offer.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  activateLocalSessionConnectIntent,
  createLocalSessionEnrollment,
  listLocalSessionEnrollments,
} from "../../state/local-session-enrollments.js";
import type { GatewayBroadcastFn } from "../server-broadcast-types.js";
import { getLocalSessionBridge, listRegisteredLocalSessionSources } from "./bridge.js";

const log = createSubsystemLogger("gateway/local-sessions");

export function activateLocalSessionConnectIntentForDevice(params: {
  setupId: string | undefined;
  deviceId: string;
  broadcast: GatewayBroadcastFn;
}): void {
  if (!params.setupId) {
    return;
  }
  const intent = activateLocalSessionConnectIntent({
    setupId: params.setupId,
    deviceId: params.deviceId,
  });
  if (!intent) {
    return;
  }
  const sources = listRegisteredLocalSessionSources();
  // Redeeming a link carries no admin authority and no request context to
  // remove projections with: it must not take over a source someone else
  // shares from this device, nor move the person's own share to another agent
  // (both are sessions.local.enroll's job), so such a source is left as it is
  // and the person sees it on Profile.
  const liveEnrollments = listLocalSessionEnrollments({ deviceId: params.deviceId }).filter(
    (candidate) => candidate.state === "pending" || candidate.state === "active",
  );
  for (const sourceId of intent.sourceIds) {
    const source = sources.find((candidate) => candidate.sourceId === sourceId);
    if (!source) {
      log.warn(
        `connect intent ${intent.setupId} names unknown local session source ${sourceId}; skipped`,
      );
      continue;
    }
    const conflicting = liveEnrollments.find(
      (candidate) =>
        candidate.sourceId === sourceId &&
        (candidate.ownerProfileId !== intent.ownerProfileId ||
          candidate.agentId !== intent.agentId),
    );
    if (conflicting) {
      log.warn(
        `connect intent ${intent.setupId}: ${sourceId} on device ${params.deviceId.slice(0, 8)} is already shared by ${conflicting.ownerLabel} into agent ${conflicting.agentId}; left unchanged`,
      );
      continue;
    }
    const enrollment = createLocalSessionEnrollment({
      ownerProfileId: intent.ownerProfileId,
      ownerLabel: intent.ownerLabel,
      deviceId: params.deviceId,
      pluginId: source.pluginId,
      sourceId,
      agentId: intent.agentId,
      setupId: intent.setupId,
    });
    params.broadcast("sessions.local.enrollment", { enrollment });
    getLocalSessionBridge()?.onEnrollmentChanged(enrollment);
  }
}
