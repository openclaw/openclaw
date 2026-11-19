// Continuation (karmaterminal): records which run consumed an event input carrying delegate
// returns (#1504). "Consumed" means the run's provider dispatch was accepted: after every
// pre-dispatch check the run handed the committed row to its provider request (the recorder's
// sentToProvider mark), and the transport carrying that request accepted it. It proves neither
// provider delivery nor that the model attended to or acted on the input.
//
// Acceptance is the dispatch owner's fact, reported through markUserTurnInputDispatched. In
// process, the provider stream function resolved with its stream: a pre-dispatch gate that rejects
// the request (rate-limit admission, auth authority, abort) never stamps, while a failure the
// provider reports inside the accepted stream, such as an HTTP 429 or 401, comes after acceptance.
// A cloud worker takes the input when the launch carrying it is dispatched to the worker or, on
// the admission protocol, when the launched worker's admission allows it; the provider request is
// then the worker's own, so a worker that later fails it still reads consumed.
//
// The input is staged before its run exists, and accepted input commits its staged bytes
// verbatim, so the run is stamped on the committed row at that boundary: a correlation-only
// rewrite that keeps the transcript generation. A row without the stamp reads as unknown, never
// as consumed: its run was aborted, blocked or refused before its dispatch was accepted, or the
// process died first. A replay's run stamps only its own row, so recovering a return never moves
// an earlier run's stamp. Delivering and acknowledging the returns never wait on the stamp.
import { publishTranscriptUpdate } from "../config/sessions/session-accessor.sqlite-events.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import { isUserMessage } from "./user-turn-transcript.message.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

type InputDispatch = {
  admissionWrite: () => Promise<void> | undefined;
  onError: (error: unknown) => void;
  stamp?: Promise<void>;
};

const inputRunIds = new WeakMap<UserTurnTranscriptRecorder, string>();
const inputDispatches = new WeakMap<UserTurnTranscriptRecorder, InputDispatch>();

/** The executing run binds itself before it may dispatch; a later preparation's run replaces it. */
export function bindUserTurnInputRunId(recorder: UserTurnTranscriptRecorder, runId: string): void {
  inputRunIds.set(recorder, runId);
}

/**
 * Only the recorder factory registers: the stamp follows its admission write, reports to its
 * persistence error handler, and its persistence waits settle the stamp.
 */
export function registerUserTurnInputDispatch(
  recorder: UserTurnTranscriptRecorder,
  admissionWrite: () => Promise<void> | undefined,
  onError: (error: unknown) => void,
): void {
  inputDispatches.set(recorder, { admissionWrite, onError });
}

/** The recorder's persistence waits settle its admission write, then the stamp scheduled behind it. */
export async function settleUserTurnInputAdmission(
  recorder: UserTurnTranscriptRecorder,
  admissionWrite: Promise<void> | undefined,
): Promise<void> {
  await admissionWrite;
  await inputDispatches.get(recorder)?.stamp;
}

/**
 * The dispatch owner reports that the transport carrying the run's request accepted it. A
 * rejected or aborted dispatch never reaches this call. Only an input the recorder marked sent
 * is stamped, and only its first scheduled stamp is kept.
 */
export function markUserTurnInputDispatched(
  recorder: UserTurnTranscriptRecorder | undefined,
): void {
  const dispatch = recorder && inputDispatches.get(recorder);
  if (dispatch && getUserTurnTranscriptAdmissionOwner(recorder)?.sentToProvider()) {
    dispatch.stamp ??= scheduleUserTurnInputRunIdStamp(
      recorder,
      dispatch.admissionWrite(),
      dispatch.onError,
    );
  }
}

/** The stamp follows the admission write, outside the request's async context. */
function scheduleUserTurnInputRunIdStamp(
  recorder: UserTurnTranscriptRecorder,
  admissionWrite: Promise<void> | undefined,
  onError: (error: unknown) => void,
): Promise<void> | undefined {
  const runId = inputRunIds.get(recorder);
  return runId
    ? Promise.resolve(admissionWrite)
        .then(
          () => runInDetachedAsyncContext(() => stampUserTurnInputRunId(recorder, runId)),
          () => undefined,
        )
        .catch(onError)
    : undefined;
}

async function stampUserTurnInputRunId(
  recorder: UserTurnTranscriptRecorder,
  runId: string,
): Promise<void> {
  const owner = getUserTurnTranscriptAdmissionOwner(recorder);
  const admission = owner?.receipt();
  if (!owner || !admission || !owner.message()?.["__openclaw"]?.inputDeliveries) {
    return;
  }
  // The first run to dispatch the row consumed it; a later run handed the same row keeps that.
  const rewritten = await rewritePreparedTranscriptMessageAtAnchor(admission, (message) =>
    isUserMessage(message) && message["__openclaw"]?.inputRunId === undefined
      ? { ...message, __openclaw: { ...message["__openclaw"], inputRunId: runId } }
      : undefined,
  );
  if (!rewritten) {
    return;
  }
  const stamped = { ...admission, generation: rewritten.generation };
  owner.refresh(stamped, rewritten.message);
  await publishTranscriptUpdate(stamped, {
    message: rewritten.message,
    messageId: stamped.entryId,
    messageSeq: stamped.activeMessagePosition + 1,
  });
}
