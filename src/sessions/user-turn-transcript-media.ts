import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { resolveSessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.transcript-target.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-pending-input-receipt.types.js";
import { discardSessionPendingInput } from "../config/sessions/session-pending-input-withdrawal.js";
import { readQueuedChatInputAdmission } from "../gateway/queued-chat-input-admission.js";
import { observeDiagnosticsTimelinePhases } from "../infra/diagnostics-timeline.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  persistUserTurnTranscript,
  resolveUserTurnTranscriptTarget,
} from "./user-turn-transcript.persistence.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
  UserTurnTranscriptTargetResolver,
} from "./user-turn-transcript.types.js";

const log = createSubsystemLogger("sessions/user-turn");
const uncertainInputOwners = new WeakSet<UserTurnTranscriptRecorder>();

function retainUncertainInputMedia(recorder: UserTurnTranscriptRecorder, error: unknown): never {
  // Lost settlement can hide a committed input that references the media.
  // Missing commit evidence does not give cleanup ownership of those bytes.
  if (hasSqliteWorkerOutcomeUnknown(error)) {
    uncertainInputOwners.add(recorder);
  }
  throw error;
}

export function retainsUserTurnTranscriptMedia(recorder: UserTurnTranscriptRecorder): boolean {
  return (
    recorder.hasPersisted() ||
    recorder.getPendingInputMessage?.() !== undefined ||
    uncertainInputOwners.has(recorder)
  );
}

export async function stageUserTurnPendingInput(
  recorder: UserTurnTranscriptRecorder,
  target: UserTurnTranscriptTarget,
  options: Parameters<typeof stageSessionPendingInput>[1] & {
    storageTarget?: Parameters<
      NonNullable<UserTurnTranscriptRecorder["stageApproved"]>
    >[0]["storageTarget"];
  },
): ReturnType<typeof stageSessionPendingInput> {
  using phase = observeDiagnosticsTimelinePhases("persist.stage.runtimeTarget");
  const config = target.config;
  const { storageTarget, ...stageOptions } = options;
  const runtimeTarget =
    storageTarget ?? (await resolveSessionTranscriptRuntimeTarget(target, config));
  phase.mark("persist.stage.custody");
  const replay = readQueuedChatInputAdmission(options.runId);
  try {
    return await stageSessionPendingInput(
      { ...target, ...runtimeTarget },
      {
        ...stageOptions,
        reattachInputId: replay?.target.inputId ?? options.reattachInputId,
        assertFreshInputCurrent: recorder.assertOriginalInputCommit,
        config,
      },
    );
  } catch (error) {
    return retainUncertainInputMedia(recorder, error);
  }
}

export async function persistUserTurnInput(
  recorder: UserTurnTranscriptRecorder,
  params: Parameters<typeof persistUserTurnTranscript>[0],
): ReturnType<typeof persistUserTurnTranscript> {
  try {
    return await persistUserTurnTranscript(params);
  } catch (error) {
    return retainUncertainInputMedia(recorder, error);
  }
}

/**
 * The runtime commits a staged steer outside pending-input custody; retire its queued row.
 * A crash before this lands replays the row, and replay dedups by idempotency key.
 */
export function retireStagedInput(
  receipt: SessionPendingInputReceipt | undefined,
  runId: string | undefined,
  targetResolver: UserTurnTranscriptTargetResolver,
): void {
  if (receipt?.state !== "queued" || !runId) {
    return;
  }
  receipt.relinquish();
  void resolveUserTurnTranscriptTarget(targetResolver)
    .then((target) => target && discardSessionPendingInput(target, runId, () => {}))
    .catch((error: unknown) => log.warn(`Staged input retirement failed: ${String(error)}`));
}
