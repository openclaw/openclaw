import { afterEach, describe, expect, it } from "vitest";
import type { WizardStartResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest, withTestTimeout } from "../../test/helpers/promise.js";
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
    "releases disconnected channel setup without an idle timeout, after writes and cleanup settle",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async ({ signal }) => {
      let phase: "before start reply" | "at prompt" | "during write" | "replacement";
      let entered = createDeferred();
      let continueWork = createDeferred();
      let cleanupStarted = createDeferred();
      let releaseCleanup = createDeferred();
      const fixtureStop = new AbortController();
      let committed: boolean;
      let submitted = false;
      await using gateway = await startWizardGateway(
        {
          channelWizardRunner: async (opts, _runtime, prompter) => {
            if (phase === "replacement") {
              await prompter.text({ message: "Replacement token", signal: fixtureStop.signal });
              return;
            }
            try {
              if (phase === "during write") {
                await opts.beforePersistentEffect?.();
                prompter.progress("Installing channel plugin");
              }
              entered.resolve();
              if (phase !== "at prompt") {
                await continueWork.promise;
              }
              if (phase === "during write") {
                opts.assertPersistentEffectCurrent?.();
                committed = true;
              }
              await prompter.text({ message: "Discord bot token", signal: fixtureStop.signal });
              submitted = true;
            } finally {
              cleanupStarted.resolve();
              await releaseCleanup.promise;
            }
          },
        },
        () => {
          fixtureStop.abort();
          continueWork.resolve();
          releaseCleanup.resolve();
        },
      );

      for (const nextPhase of ["before start reply", "at prompt", "during write"] as const) {
        phase = nextPhase;
        entered = createDeferred();
        continueWork = createDeferred();
        cleanupStarted = createDeferred();
        releaseCleanup = createDeferred();
        committed = false;
        const client = await gateway.connect("channel-setup-owner");
        // Attach rejection handling before disconnecting the request whose reply is lost.
        const start = client
          .request<WizardStartResult>("wizard.start", { flow: "channels", channel: "discord" })
          .catch(() => undefined);
        await entered.promise;
        if (phase !== "before start reply") {
          expect(await start).toMatchObject({ done: false, status: "running" });
        }
        await disconnectGatewayClient(client);
        await start;
        const reconnected = await gateway.connect("channel-setup-reconnected");
        const expectBusy = () =>
          expect(
            reconnected.request("wizard.start", { flow: "channels", channel: "discord" }),
          ).rejects.toMatchObject({
            code: "UNAVAILABLE",
            details: { code: "SETUP_ADMISSION_BUSY" },
          });
        await expectBusy();
        expect(committed).toBe(false);
        continueWork.resolve();
        await withinTest(cleanupStarted.promise, signal);
        expect(committed).toBe(phase === "during write");
        expect(submitted).toBe(false);
        await expectBusy();
        releaseCleanup.resolve();
        expect((await waitForGatewayActiveWork(5_000)).drained).toBe(true);

        phase = "replacement";
        const replacement = await reconnected.request<WizardStartResult>("wizard.start", {
          flow: "channels",
          channel: "discord",
        });
        expect(replacement.step).toMatchObject({ type: "text", message: "Replacement token" });
        await reconnected.request("wizard.cancel", {
          sessionId: replacement.sessionId,
          closeInput: true,
        });
        await expect(reconnected.request("health", {})).resolves.toBeDefined();
        await disconnectGatewayClient(reconnected);
      }
    },
  );

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
