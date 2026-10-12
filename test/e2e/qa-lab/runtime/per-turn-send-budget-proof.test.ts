import { describe, expect, it } from "vitest";
import {
  aggregateTurnSendProof,
  createTurnSendProofOutcomes,
  recordTurnSendProofSuccess,
  REQUIRED_TURN_SEND_SCENARIO_IDS,
  type TurnSendScenarioOutcome,
} from "./per-turn-send-budget-proof.js";

const complete = (): TurnSendScenarioOutcome[] =>
  REQUIRED_TURN_SEND_SCENARIO_IDS.map((id) => ({ id, status: "success", pass: true }));

type ProofMutation = (rows: TurnSendScenarioOutcome[]) => TurnSendScenarioOutcome[];

const failingOutcomeSets: Array<readonly [string, ProofMutation]> = [
  ["incomplete", (rows) => rows.slice(1)],
  ["failed", (rows) => [{ ...rows[0]!, status: "failed", pass: false }, ...rows.slice(1)]],
  ...(["skipped", "timed_out", "filtered"] as const).map(
    (status) =>
      [
        status,
        (rows: TurnSendScenarioOutcome[]) => [
          { ...rows[0]!, status, pass: false },
          ...rows.slice(1),
        ],
      ] as const,
  ),
  ["duplicate", (rows) => [...rows, rows[0]!]],
  ["unknown", (rows) => [...rows.slice(1), { id: "unknown", status: "success", pass: true }]],
];

describe("per-turn send budget proof aggregation", () => {
  it("accepts exactly one successful terminal outcome for every required scenario", () => {
    expect(aggregateTurnSendProof(complete()).pass).toBe(true);
  });

  it("starts every required scenario incomplete and replaces only its matching stable id", () => {
    const outcomes = createTurnSendProofOutcomes();
    expect(aggregateTurnSendProof(outcomes).pass).toBe(false);
    recordTurnSendProofSuccess(outcomes, {
      ...outcomes[0]!,
      id: REQUIRED_TURN_SEND_SCENARIO_IDS[0],
    });
    expect(outcomes[0]).toMatchObject({
      id: REQUIRED_TURN_SEND_SCENARIO_IDS[0],
      status: "success",
      pass: true,
    });
    expect(aggregateTurnSendProof(outcomes).unsuccessful).toHaveLength(
      REQUIRED_TURN_SEND_SCENARIO_IDS.length - 1,
    );
  });

  it.each(failingOutcomeSets)("fails closed for a %s outcome set", (_label, mutate) => {
    expect(aggregateTurnSendProof(mutate(complete())).pass).toBe(false);
  });
});
