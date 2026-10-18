// Prove subagent Stop settlement through public Gateway admission and HTTP control.
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type {
  EmbeddedAgentRunResult,
  runEmbeddedAgent as runEmbeddedAgentType,
} from "../agents/embedded-agent.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../sessions/session-controller.lifecycle.js";
import {
  completedEmbeddedRun,
  createNaturalSubagentStopHarness,
  type KillResponse,
} from "./server.subagent-stop-settlement.product.test-support.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn<typeof runEmbeddedAgentType>());

vi.mock("../agents/embedded-agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/embedded-agent.js")>();
  return { ...actual, runEmbeddedAgent };
});

afterEach(async () => {
  vi.useRealTimers();
  runEmbeddedAgent.mockReset();
  await resetSubagentRegistryForTests({ persist: false });
});

it("bounds public child Stop when the accepted agent source never settles", async () => {
  const childStarted = createDeferred<Parameters<typeof runEmbeddedAgentType>[0]>();
  const childCancelled = createDeferred();
  const finishChild = createDeferred<EmbeddedAgentRunResult>();
  const harness = await createNaturalSubagentStopHarness({
    label: "subagent-stop-settlement",
    runEmbeddedAgent,
    runChild: async (params) => {
      params.abortSignal?.addEventListener("abort", () => childCancelled.resolve(), { once: true });
      childStarted.resolve(params);
      return await finishChild.promise;
    },
  });
  let stopResponse: Promise<KillResponse> | undefined;
  await runQaGatewayFixture(
    async () => {
      await harness.start();
      const receipt = await harness.spawn();
      await childStarted.promise;
      const rootsBeforeStop = getActiveGatewayRootWorkCount();
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      stopResponse = harness.stop(receipt.childSessionKey);
      let settledResponse: Awaited<typeof stopResponse> | undefined;
      void stopResponse.then((response) => {
        settledResponse = response;
      });
      await expect(
        Promise.race([
          childCancelled.promise.then(() => "cancelled" as const),
          stopResponse.then(() => "responded" as const),
        ]),
      ).resolves.toBe("cancelled");
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS * 2 + 1);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(
        settledResponse,
        "HTTP Stop must return at the controller drain deadline",
      ).toBeDefined();
      const response = await stopResponse;
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/cleanup remains pending/i) },
      });
      expect(getActiveGatewayRootWorkCount()).toBe(rootsBeforeStop);
    },
    () => finishChild.resolve(completedEmbeddedRun),
    async () => {
      if (stopResponse) {
        await stopResponse.catch(() => undefined);
      }
    },
    () => harness.disconnect(),
    () => harness.close(),
    () => harness.state.cleanup(),
  );
});
