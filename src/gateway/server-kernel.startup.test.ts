import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { getPairedDevice, withPairedDeviceRecords } from "../infra/device-pairing.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import * as coreRuntime from "./server-core-runtime.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { closeKernelFixture, createKernelFixture } from "./server-kernel.fixture-test-support.js";
import { createGatewayKernel } from "./server-kernel.js";
import * as lifecycleRuntime from "./server-lifecycle.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";

it("projects current worker placement through registered session reads", async () => {
  const fixture = await createKernelFixture("gateway-kernel-placement-projection", {
    layout: "home",
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
  });
  const { state } = fixture;
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  try {
    await fixture.configure({
      agents: { defaults: { model: "unit-test/model", utilityModel: "" } },
    });
    await withPairedDeviceRecords(undefined, (paired) => {
      paired["startup-device"] = {
        deviceId: "startup-device",
        publicKey: "synthetic-startup-key",
        createdAtMs: 1,
        approvedAtMs: 1,
      };
      return { value: undefined, persist: true };
    });
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:placement",
      sessionId: "placement",
    };
    replaceSessionEntrySync(identity, { sessionId: identity.sessionId, updatedAt: Date.now() });
    kernel = await fixture.open();
    kernel.kernel.setDispatchReady(true);
    {
      using _ = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockRejectedValue(new Error("reader busy after startup"));
      expect(await getPairedDevice("startup-device")).toMatchObject({
        publicKey: "synthetic-startup-key",
      });
    }
    const placements = expectDefined(
      kernel.workerEnvironmentStartup?.placementStore,
      "worker placement store",
    );
    const dispatchOptions = {
      client: createSyntheticPluginRuntimeClient({ scopes: [...CLI_DEFAULT_OPERATOR_SCOPES] }),
      context: kernel.gatewayRequestContext,
      methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
    };
    const describePlacement = () =>
      dispatchGatewayRequestInProcess<{ session: GatewaySessionRow | null }>(
        "sessions.describe",
        { key: identity.sessionKey },
        dispatchOptions,
      );
    reportPlacementTransition(undefined, await placements.startDispatch(identity));
    expect((await describePlacement()).session).toMatchObject({
      sessionId: identity.sessionId,
      placement: { state: "requested" },
    });
    reportPlacementTransition(
      undefined,
      await placements.fail({ sessionId: identity.sessionId, recoveryError: "Current failure" }),
    );
    expect((await describePlacement()).session).toMatchObject({
      sessionId: identity.sessionId,
      placement: { state: "failed" },
    });
  } finally {
    await closeKernelFixture(kernel, state);
  }
});

it.each([false, true])(
  "services queued tasks after preparing shutdown (cancel: %s)",
  async (cancel) => {
    const port = await getDeterministicFreePortBlock({ offsets: [0] });
    const token = "gateway-startup-fairness-token-1234567890";
    const { state, open } = await createKernelFixture("gateway-startup-fairness", {
      port,
      token,
      layout: "home",
      scenario: "gateway-loopback",
      gateway: { port, token },
    });
    const events: string[] = [];
    const prepareLifecycle = lifecycleRuntime.prepareGatewayLifecycle;
    const startCore = coreRuntime.startGatewayCoreRuntime;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    let pendingTask: Promise<void> | undefined;
    vi.spyOn(lifecycleRuntime, "prepareGatewayLifecycle").mockImplementation(async (params) => {
      const prepared = await prepareLifecycle(params);
      events.push("shutdown prepared");
      // Queue in the kernel's timer phase; message-port ordering relative to timers varies.
      pendingTask = delay(0).then(async () => {
        events.push("queued task");
        if (cancel) {
          await prepared.prepareClose();
        }
      });
      void pendingTask.catch(() => {});
      return prepared;
    });
    const start = vi
      .spyOn(coreRuntime, "startGatewayCoreRuntime")
      .mockImplementation(async (params) => {
        events.push("core startup");
        return await startCore(params);
      });
    await runQaGatewayFixture(
      async () => {
        const startup = open().then((created) => {
          kernel = created;
          return created;
        });
        if (cancel) {
          await expect(startup).rejects.toThrow();
          expect(start).not.toHaveBeenCalled();
          expect(events).toEqual(["shutdown prepared", "queued task"]);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
        } else {
          kernel = await startup;
          expect(events).toEqual(["shutdown prepared", "queued task", "core startup"]);
          expect(kernel.startupState.dispatchReady).toBe(false);
          expect(kernel.lifecycle.closePreludeStarted).toBe(false);
        }
      },
      () => pendingTask,
      () => kernel?.closeOnStartupFailure(),
      async () => {
        vi.restoreAllMocks();
        await state.cleanup();
      },
    );
  },
);
