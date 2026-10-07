import {
  noteClientVoiceConfirmationUtterance,
  prepareClientVoiceConfirmationTranscript,
  recordClientVoiceConfirmationTranscriptAppend,
} from "./client-voice-confirmation.js";

/** Fixture for speech observed and persisted immediately at the supplied host time. */
export function noteClientVoiceConfirmationUtteranceForTest(
  params: Omit<Parameters<typeof noteClientVoiceConfirmationUtterance>[0], "confirmation"> & {
    text: string;
  },
): void {
  const entryId = `fixture-${params.timestamp}`;
  const confirmation = prepareClientVoiceConfirmationTranscript({
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    now: params.timestamp,
    entryId,
  });
  if (!confirmation) {
    throw new Error("Expected a synthetic transcript observation");
  }
  recordClientVoiceConfirmationTranscriptAppend({
    confirmation,
    entryId,
    text: params.text,
    appended: true,
  });
  noteClientVoiceConfirmationUtterance({
    ...params,
    confirmation,
  });
}

type ClientVoiceConfirmationTestApi = {
  resetClientVoiceConfirmationStateForTest(): void;
  snapshotClientVoiceConfirmationStateForTest(): ClientVoiceConfirmationStateSnapshot;
};

export type ClientVoiceConfirmationStateSnapshot = {
  scopeOwners: number;
  pendingChallenges: number;
  recentUtterances: number;
  approvedRuns: number;
  approvedGrants: number;
  expiryOwners: number;
};

function getTestApi(): ClientVoiceConfirmationTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceConfirmationTestApi")
  ] as ClientVoiceConfirmationTestApi;
}

export function resetClientVoiceConfirmationStateForTest(): void {
  getTestApi().resetClientVoiceConfirmationStateForTest();
}

export function snapshotClientVoiceConfirmationStateForTest(): ClientVoiceConfirmationStateSnapshot {
  return getTestApi().snapshotClientVoiceConfirmationStateForTest();
}
