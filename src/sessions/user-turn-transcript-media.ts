import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { resolveSessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.transcript-target.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "./user-turn-transcript.types.js";

const uncertainPendingInputOwners = new WeakSet<UserTurnTranscriptRecorder>();

export function retainsUserTurnTranscriptMedia(recorder: UserTurnTranscriptRecorder): boolean {
  return (
    recorder.hasPersisted() ||
    recorder.getPendingInputMessage?.() !== undefined ||
    uncertainPendingInputOwners.has(recorder)
  );
}

export async function stageUserTurnPendingInput(
  recorder: UserTurnTranscriptRecorder,
  target: UserTurnTranscriptTarget,
  options: Parameters<typeof stageSessionPendingInput>[1],
): ReturnType<typeof stageSessionPendingInput> {
  const config = target.config;
  const runtimeTarget = await resolveSessionTranscriptRuntimeTarget(target, config);
  try {
    return await stageSessionPendingInput({ ...target, ...runtimeTarget }, { ...options, config });
  } catch (error) {
    // Lost settlement can hide a committed row that already references the
    // media. No returned receipt is not proof that cleanup owns those bytes.
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      uncertainPendingInputOwners.add(recorder);
    }
    throw error;
  }
}
