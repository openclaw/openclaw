import type { TranscriptEntryAnchor } from "../config/sessions/session-accessor.js";
import type {
  PersistUserTurnTranscriptParams,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

type InputNotifier = (anchor: TranscriptEntryAnchor) => void;
const originalInputCommitNotifiers = new WeakMap<UserTurnTranscriptRecorder, InputNotifier>();

export function notifyOriginalInputCommitted(
  recorder: UserTurnTranscriptRecorder,
  anchor: TranscriptEntryAnchor,
): void {
  originalInputCommitNotifiers.get(recorder)?.(anchor);
}

export function registerOriginalInputCommitNotifier(
  recorder: UserTurnTranscriptRecorder,
  notifier: InputNotifier,
): void {
  originalInputCommitNotifiers.set(recorder, notifier);
}

type UserTurnTranscriptTestApi = {
  persistUserTurnTranscript(
    params: PersistUserTurnTranscriptParams,
  ): Promise<UserTurnTranscriptPersistResult | undefined>;
};

export function publishUserTurnTranscriptTestApi(api: UserTurnTranscriptTestApi): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    // SAFETY: The repository test registry owns this symbol and consumes this exact API shape.
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.userTurnTranscriptTestApi")] =
      api;
  }
}
