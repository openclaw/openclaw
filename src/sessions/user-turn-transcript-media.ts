import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { resolveSessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.transcript-target.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.persistence.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "./user-turn-transcript.types.js";

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
  options: Parameters<typeof stageSessionPendingInput>[1],
): ReturnType<typeof stageSessionPendingInput> {
  const config = target.config;
  const runtimeTarget = await resolveSessionTranscriptRuntimeTarget(target, config);
  try {
    return await stageSessionPendingInput({ ...target, ...runtimeTarget }, { ...options, config });
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
