export type MeetingSpeechOutputHealth = {
  lastOutputBytes?: number;
  outputGeneration?: number;
  verifiedOutputGeneration?: number;
};

export type MeetingSpeechOutputBaseline = {
  outputBytes: number;
  outputGeneration: number;
};

export function readMeetingSpeechOutputBaseline(
  health: MeetingSpeechOutputHealth | undefined,
): MeetingSpeechOutputBaseline {
  return {
    outputBytes: health?.lastOutputBytes ?? 0,
    outputGeneration: health?.outputGeneration ?? 0,
  };
}

/** Fresh sink bytes are verified only after non-silent audio returns on the mic capture path. */
export function isMeetingSpeechOutputVerified(
  health: MeetingSpeechOutputHealth | undefined,
  baseline: MeetingSpeechOutputBaseline,
): boolean {
  return (
    (health?.lastOutputBytes ?? 0) > baseline.outputBytes &&
    (health?.outputGeneration ?? 0) > baseline.outputGeneration &&
    health?.verifiedOutputGeneration === health?.outputGeneration
  );
}
