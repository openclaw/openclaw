import { recordSessionParticipant } from "../config/sessions/session-accessor.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "./session-key-utils.js";

type ParticipantRecordingTarget = { agentId: string; sessionKey: string; storePath: string };
const log = createSubsystemLogger("sessions/participants");
const pendingRecordings = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionParticipantRecordings"),
  () => new Map<string, Set<Promise<void>>>(),
);

function participantSessionKey(target: ParticipantRecordingTarget): string {
  const agentId = normalizeAgentId(target.agentId);
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(target.sessionKey);
  const sessionKey =
    normalized === "global" || normalized === "unknown"
      ? normalized
      : toAgentStoreSessionKey({ agentId, requestKey: normalized });
  return JSON.stringify([agentId, sessionKey]);
}

/** Join accepted input before snapshotting its credit, outside any store/lifecycle hold. */
export async function waitForSessionParticipantRecording(
  target: ParticipantRecordingTarget,
): Promise<void> {
  const pending = [...(pendingRecordings.get(participantSessionKey(target)) ?? [])];
  if (pending.length === 0) {
    return;
  }
  // Same-key work in another custom store may also be joined; no writes are redirected.
  await Promise.allSettled(pending);
}

/** Defers participant history persistence so it can never delay or abort an admitted turn. */
export function recordSessionParticipantBestEffort(params: {
  identity: SessionParticipantIdentity;
  agentId: string;
  sessionKey: string;
  storePath: string;
  promptedAt?: number;
  onError?: (error: unknown) => void;
}): void {
  const promptedAt = params.promptedAt ?? Date.now();
  const reportFailure = (error: unknown) => {
    if (params.onError) {
      params.onError(error);
    } else {
      log.warn(`failed to record session participant: ${String(error)}`);
    }
  };
  const work = trackAsyncWork(() =>
    runOutsideGatewayRootWorkAdmission(async () => {
      await Promise.resolve();
      try {
        await recordSessionParticipant(
          {
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          },
          {
            identity: params.identity,
            promptedAt,
            sessionAgentId: params.agentId,
          },
        );
      } catch (error) {
        reportFailure(error);
      }
    }),
  ).catch(reportFailure);
  const key = participantSessionKey(params);
  const pending = pendingRecordings.get(key) ?? new Set<Promise<void>>();
  pending.add(work);
  pendingRecordings.set(key, pending);
  const settled = () => {
    pending.delete(work);
    if (pending.size === 0) {
      pendingRecordings.delete(key);
    }
  };
  void work.then(settled, settled);
}
