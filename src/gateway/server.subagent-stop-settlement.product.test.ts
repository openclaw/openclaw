// Prove subagent Stop settlement through public Gateway admission and HTTP control.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type {
  EmbeddedAgentRunResult,
  runEmbeddedAgent as runEmbeddedAgentType,
} from "../agents/embedded-agent.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { captureGatewayRootWorkReleaseObserver } from "../process/gateway-work-admission.js";
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
  const childStarted = createDeferred<ReturnType<typeof captureGatewayRootWorkReleaseObserver>>();
  const childRootReleased = vi.fn();
  const childCancelled = createDeferred();
  const finishChild = createDeferred<EmbeddedAgentRunResult>();
  const harness = await createNaturalSubagentStopHarness({
    label: "subagent-stop-settlement",
    runEmbeddedAgent,
    runChild: async (params) => {
      params.abortSignal?.addEventListener("abort", () => childCancelled.resolve(), { once: true });
      childStarted.resolve(captureGatewayRootWorkReleaseObserver());
      return await finishChild.promise;
    },
  });
  let stopResponse: Promise<KillResponse> | undefined;
  await runQaGatewayFixture(
    async () => {
      await harness.start();
      const receipt = await harness.spawn();
      expectDefined(await childStarted.promise, "admitted child root")(childRootReleased);
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      stopResponse = harness.stop(receipt.childSessionKey);
      await expect(
        Promise.race([
          childCancelled.promise.then(() => "cancelled" as const),
          stopResponse.then(() => "responded" as const),
        ]),
      ).resolves.toBe("cancelled");
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS * 2 + 1);
      // Keep the clock frozen at the drain deadline while HTTPS delivery finishes.
      const response = await stopResponse;
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/cleanup remains pending/i) },
      });
      expect(childRootReleased).not.toHaveBeenCalled();
    },
    () => finishChild.resolve(completedEmbeddedRun),
    () => stopResponse?.catch(() => undefined),
    () => harness.disconnect(),
    () => harness.close(),
    () => expect(childRootReleased).toHaveBeenCalledExactlyOnceWith("settled"),
    () => harness.state.cleanup(),
  );
});
