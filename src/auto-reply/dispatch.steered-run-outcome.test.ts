import { expect, it } from "vitest";
import { runSteeredOutcomeScenario } from "./dispatch.steered-run-outcome.test-support.js";

it(
  "a consumed steer completes with the consuming run's successful settlement",
  { timeout: 240000 },
  async () => {
    await expect(runSteeredOutcomeScenario("completed")).resolves.toBeUndefined();
  },
);
