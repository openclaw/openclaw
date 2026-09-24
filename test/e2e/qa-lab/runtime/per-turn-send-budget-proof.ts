export const REQUIRED_TURN_SEND_SCENARIO_IDS = [
  "sanity",
  "soft-nudge",
  "hard-cap",
  "suppressed-not-charged",
  "idempotent-replay",
  "concurrent-cap",
  "direct-repeat",
  "authority-chain",
] as const;

export type TurnSendScenarioId = (typeof REQUIRED_TURN_SEND_SCENARIO_IDS)[number];
export type TurnSendTerminalStatus =
  | "incomplete"
  | "success"
  | "failed"
  | "skipped"
  | "timed_out"
  | "filtered";

export type TurnSendScenarioOutcome = {
  id: string;
  status: TurnSendTerminalStatus;
  pass: boolean;
};

/**
 * Seed an artifact before the suite begins. A test that aborts before it can record its
 * success retains its stable id with an explicit incomplete outcome, so a partial run
 * cannot be mistaken for a complete proof.
 */
export function createTurnSendProofOutcomes(): TurnSendScenarioOutcome[] {
  return REQUIRED_TURN_SEND_SCENARIO_IDS.map((id) => ({
    id,
    status: "incomplete",
    pass: false,
  }));
}

/** Replaces one pre-registered outcome after its assertions have all succeeded. */
export function recordTurnSendProofSuccess<T extends TurnSendScenarioOutcome>(
  outcomes: T[],
  outcome: Omit<T, "status" | "pass"> & Partial<Pick<T, "status" | "pass">>,
): void {
  const index = outcomes.findIndex((candidate) => candidate.id === outcome.id);
  if (index === -1) {
    throw new Error(`cannot record unknown turn-send proof scenario: ${outcome.id}`);
  }
  outcomes[index] = { ...outcome, status: "success", pass: true } as T;
}

export function aggregateTurnSendProof<T extends TurnSendScenarioOutcome>(raw: readonly T[]) {
  const required = new Set<string>(REQUIRED_TURN_SEND_SCENARIO_IDS);
  const counts = new Map<string, number>();
  for (const outcome of raw) {
    counts.set(outcome.id, (counts.get(outcome.id) ?? 0) + 1);
  }
  const missing = REQUIRED_TURN_SEND_SCENARIO_IDS.filter((id) => !counts.has(id));
  const duplicate = [...counts].filter(([, count]) => count !== 1).map(([id]) => id);
  const unknown = [...counts.keys()].filter((id) => !required.has(id));
  const unsuccessful = raw
    .filter((outcome) => outcome.status !== "success" || outcome.pass !== true)
    .map((outcome) => outcome.id);
  return {
    pass:
      raw.length === REQUIRED_TURN_SEND_SCENARIO_IDS.length &&
      missing.length === 0 &&
      duplicate.length === 0 &&
      unknown.length === 0 &&
      unsuccessful.length === 0,
    missing,
    duplicate,
    unknown,
    unsuccessful,
  };
}
