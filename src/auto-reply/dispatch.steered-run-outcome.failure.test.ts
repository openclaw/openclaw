import { expect, it } from "vitest";
import { runSteeredOutcomeScenario } from "./dispatch.steered-run-outcome.test-support.js";

it(
  "a consumed steer fails with the consuming run's failed settlement",
  { timeout: 240000 },
  async () => {
    await expect(runSteeredOutcomeScenario("failed")).resolves.toBeUndefined();
  },
);
