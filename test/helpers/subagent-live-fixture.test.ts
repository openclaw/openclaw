import { setImmediate } from "node:timers/promises";
import { expect, it, vi, type TestContext } from "vitest";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { createDeferred } from "./promise.js";

const { closeGateway } = vi.hoisted(() => ({ closeGateway: vi.fn() }));
// mock-isolation: model-free lifecycle proof supplies only the external Gateway owner.
vi.mock("../../src/gateway/server.js", () => ({
  startGatewayServer: async () => ({ startupSettled: Promise.resolve(), close: closeGateway }),
}));
// mock-isolation: no model or socket requests are needed to test fixture teardown custody.
vi.mock("./gateway-client.js", () => ({
  acquireGatewayTestClient: async () => ({ stopAndWait: async () => {} }),
}));

it("joins cancelled live-subagent teardown before the next test can start", async (context) => {
  const { runWithLiveSubagentGateway } =
    await import("../../src/agents/subagents/announce/subagent-challenges.live.test-support.js");
  const closing = createDeferred();
  const release = createDeferred();
  const controller = new AbortController();
  const hooks: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
  closeGateway.mockImplementation(async () => {
    closing.resolve();
    await release.promise;
  });
  const cancelledContext = {
    signal: controller.signal,
    onTestFinished: (hook: Parameters<TestContext["onTestFinished"]>[0]) => hooks.push(hook),
  };
  await withEnvAsync({ OPENAI_API_KEY: "synthetic-no-model-requests" }, async () => {
    const running = runWithLiveSubagentGateway({}, async () => {}, cancelledContext);
    let nextCaseStarted = false;
    let finishing: Promise<void> | undefined;
    try {
      await closing.promise;
      controller.abort(new Error("simulated test timeout during Gateway teardown"));
      finishing = (async () => {
        for (const hook of hooks.toReversed()) {
          await hook(context);
        }
        nextCaseStarted = true;
      })();
      await setImmediate();
      expect(
        nextCaseStarted,
        "Gateway close must settle before the worker starts another test",
      ).toBe(false);
      release.resolve();
      await running;
      await finishing;
      expect(nextCaseStarted).toBe(true);
    } finally {
      release.resolve();
      await running;
      await finishing;
      closeGateway.mockReset();
    }
  });
});
