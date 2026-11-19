import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runAgent = await h.loadRunCronIsolatedAgentTurn();
const withinWindow = Date.parse("2026-10-20T09:30:00.000Z");
const afterWindow = Date.parse("2026-10-20T10:00:00.000Z");
const activeHours = { start: "09:00", end: "10:00", timezone: "UTC" };

function controlClock() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(withinWindow);
  onTestFinished(() => clock.mockRestore());
  return clock;
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return makeIsolatedAgentParamsFixture({
    job: makeIsolatedAgentJobFixture({ activeHours, idleOnly: true, delivery: { mode: "none" } }),
    ...overrides,
  });
}

const deferredByWindow = {
  status: "skipped",
  executionStarted: false,
  admissionDeferred: true,
  admissionDeferredReason: "active-hours",
};

function expectNoEffect(...effects: ReturnType<typeof vi.fn>[]) {
  for (const effect of effects) {
    expect(effect).not.toHaveBeenCalled();
  }
}

describe("isolated automation actual-start policy", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => h.mockRunCronFallbackPassthrough());

  it.each(["embedded", "cli"] as const)(
    "defers a prepared %s run when its window closes before the provider effect",
    async (backend) => {
      const clock = controlClock();
      const providerEffect = vi.fn();
      const onExecutionStarted = vi.fn();
      h.isCliProviderMock.mockReturnValue(backend === "cli");
      const runner = backend === "cli" ? h.runCliAgentMock : h.runEmbeddedAgentMock;
      runner.mockImplementationOnce(async (runParams) => {
        clock.mockReturnValue(afterWindow);
        await runParams.onExecutionStarted?.();
        providerEffect();
        return {
          payloads: [{ text: "Should not run outside the window" }],
          meta: { agentMeta: {} },
        };
      });

      const result = await runAgent(makeParams({ onExecutionStarted }));

      expect(runner).toHaveBeenCalledOnce();
      expect(result).toMatchObject(deferredByWindow);
      expectNoEffect(providerEffect, onExecutionStarted, h.dispatchCronDeliveryMock);
    },
  );
});
