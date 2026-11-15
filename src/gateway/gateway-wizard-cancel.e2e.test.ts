import { afterEach, describe, expect, it } from "vitest";
import type { WizardStartResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  enqueueCommandInLane,
  getTotalQueueSize,
  markGatewayDraining,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { startWizardGateway } from "./gateway-wizard.test-support.js";
import { resetGatewayTestState as resetSharedGatewayTestState } from "./gateway.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;
afterEach(() => {
  resetSharedGatewayTestState();
  // Unlike the shared reset, cancellation tests also retire listeners and queue owners.
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  resetGatewayWorkAdmission();
});

describe("gateway wizard cancellation lifecycle", () => {
  it(
    "keeps a cancelled wizard owner until settlement before allowing a replacement",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const runnerSettled = [createDeferred(), createDeferred()] as const;
      let runnerIndex = 0;
      await using gateway = await startWizardGateway(
        {
          wizardRunner: async (_opts, _runtime, prompter) => {
            const settlement = runnerSettled[runnerIndex++];
            if (!settlement) {
              throw new Error("wizard runner started more than twice");
            }
            prompter.progress("working");
            await settlement.promise;
          },
        },
        () => {
          runnerSettled[0].resolve();
          runnerSettled[1].resolve();
        },
      );
      const client = await gateway.connect("vitest-wizard-cancel");
      const start = await client.request<WizardStartResult>("wizard.start", { mode: "local" });
      expect(start).toMatchObject({ done: false, status: "running" });
      await expect(
        client.request("wizard.cancel", { sessionId: start.sessionId }),
      ).resolves.toMatchObject({ status: "cancelled" });
      await expect(client.request("wizard.start", { mode: "local" })).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      runnerSettled[0].resolve();
      let replacement: WizardStartResult | undefined;
      await expect
        .poll(
          async () => {
            try {
              replacement = await client.request<WizardStartResult>("wizard.start", {
                mode: "local",
              });
              return replacement.status;
            } catch {
              return "blocked";
            }
          },
          { timeout: 5_000 },
        )
        .toBe("running");
      if (!replacement) {
        throw new Error("replacement wizard did not start");
      }
      expect(replacement).toMatchObject({ done: false, status: "running" });
      await expect(client.request("health", {})).resolves.toBeDefined();
      await expect(
        client.request("wizard.cancel", { sessionId: replacement.sessionId }),
      ).resolves.toMatchObject({ status: "cancelled" });
      runnerSettled[1].resolve();
    },
  );

  it.each(["process drain", "server close"])(
    "retires an abandoned reconnectable wizard before %s joins its cleanup",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async (closing) => {
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      const fixtureStop = new AbortController();
      let submitted = false;
      let closed = false;
      let closingServer: Promise<void> | undefined;
      await using gateway = await startWizardGateway(
        {
          wizardRunner: async (_opts, _runtime, prompter) => {
            await enqueueCommandInLane("wizard-shutdown-e2e", async () => {
              try {
                await prompter.text({
                  message: "Local model base URL",
                  signal: fixtureStop.signal,
                });
                submitted = true;
              } finally {
                cleanupStarted.resolve();
                await releaseCleanup.promise;
              }
            });
          },
        },
        () => {
          fixtureStop.abort();
          releaseCleanup.resolve();
        },
      );
      const first = await gateway.connect("vitest-wizard-cancel");
      const start = await first.request<WizardStartResult>("wizard.start", { mode: "local" });
      expect(start.step?.type).toBe("text");
      await disconnectGatewayClient(first);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      const reconnected = await gateway.connect("vitest-wizard-cancel");
      await expect(
        reconnected.request("wizard.next", { sessionId: start.sessionId }),
      ).resolves.toMatchObject({
        done: false,
        status: "running",
        step: { id: start.step?.id },
      });
      await disconnectGatewayClient(reconnected);
      expect(getTotalQueueSize()).toBe(1);
      if (closing === "process drain") {
        markGatewayDraining();
      } else {
        closingServer = gateway.server.close({ reason: "abandoned wizard proof" }).then(() => {
          closed = true;
        });
      }
      await withTestTimeout(
        cleanupStarted.promise,
        1_000,
        "shutdown did not retire the abandoned prompt",
      );
      expect(submitted).toBe(false);
      expect(closed).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(getTotalQueueSize()).toBe(1);
      releaseCleanup.resolve();
      expect((await waitForGatewayActiveWork(5_000)).drained).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(getTotalQueueSize()).toBe(0);
      await closingServer;
    },
  );
});
