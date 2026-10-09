import path from "node:path";
import { recordSessionParticipant } from "../config/sessions/session-accessor.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "./session-key-utils.js";

type ParticipantRecordingTarget = { agentId: string; sessionKey: string; storePath: string };
type PendingParticipantRecording = {
  target: ParticipantRecordingTarget;
  env: ReturnType<typeof captureSessionTranscriptStorageEnvironment>;
  work: Promise<void>;
};

const pendingRecordings = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionParticipantRecordings"),
  () => new Map<string, Set<PendingParticipantRecording>>(),
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

async function participantStorePath(
  target: ParticipantRecordingTarget,
  env: PendingParticipantRecording["env"],
): Promise<string> {
  const resolved = await prepareSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
    env,
  });
  return resolveIdentityPathViaExistingAncestorSync(resolved.path);
}

/** Join accepted input before snapshotting its credit, outside any store/lifecycle hold. */
export async function waitForSessionParticipantRecording(
  target: ParticipantRecordingTarget,
): Promise<void> {
  const pending = [...(pendingRecordings.get(participantSessionKey(target)) ?? [])];
  if (pending.length === 0) {
    return;
  }
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  let physicalTarget: Promise<string> | undefined;
  await Promise.allSettled(
    pending.map(async (recording) => {
      if (path.resolve(recording.target.storePath) !== path.resolve(target.storePath)) {
        const [requested, recorded] = await Promise.all([
          (physicalTarget ??= participantStorePath(target, env)),
          participantStorePath(recording.target, recording.env),
        ]);
        if (requested !== recorded) {
          return;
        }
      }
      await recording.work;
    }),
  );
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
        params.onError?.(error);
      }
    }),
  ).catch((error: unknown) => params.onError?.(error));
  const key = participantSessionKey(params);
  const pending = pendingRecordings.get(key) ?? new Set<PendingParticipantRecording>();
  const recording = {
    target: { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    env: captureSessionTranscriptStorageEnvironment(process.env),
    work,
  };
  pending.add(recording);
  pendingRecordings.set(key, pending);
  const settled = () => {
    pending.delete(recording);
    if (pending.size === 0) {
      pendingRecordings.delete(key);
    }
  };
  void work.then(settled, settled);
}
