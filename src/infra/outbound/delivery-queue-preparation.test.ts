import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import * as queueWorker from "../delivery-queue-worker-store.js";
import { OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { withStableDeliveryPreparation } from "./delivery-queue-preparation.js";

describe("stable delivery preparation", () => {
  let stateDir = "";
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  beforeEach(() => {
    closeOpenClawStateDatabaseForTest();
    stateDir = tempDirs.make("openclaw-stable-preparation-");
  });

  it.each(["claimed", "modifiers_started"] as const)(
    "preserves ordinary checkpoint failure cleanup from %s",
    async (state) => {
      const failure = new Error("checkpoint rejected before native storage");
      const execute = queueWorker.executeDeliveryQueueOperation;
      let failed = false;
      const operations = vi
        .spyOn(queueWorker, "executeDeliveryQueueOperation")
        .mockImplementation(async (...args) => {
          const command = args[2];
          if (
            command.type === "deliveryQueue.replacePreparation" &&
            command.input.replacementEntry.preparationState === "prepared" &&
            !failed
          ) {
            failed = true;
            throw failure;
          }
          return execute(...args);
        });
      try {
        await expect(
          withStableDeliveryPreparation({
            id: "ordinary-checkpoint-failure",
            stateDir,
            run: async (owner) => {
              if (state === "modifiers_started") {
                await owner.beforeFirstModifier();
              }
              await owner.markPrepared();
            },
          }),
        ).rejects.toBe(failure);
        const writes = operations.mock.calls.map((args) => args[2]);
        if (state === "claimed") {
          const release = writes.at(-1);
          expect(release).toMatchObject({
            type: "deliveryQueue.replacePreparation",
            input: {
              replacementEntry: { preparationState: "claimed", preparationLeaseExpiresAt: 0 },
            },
          });
          expect(
            writes.filter((command) => command.type === "deliveryQueue.failPreparation"),
          ).toHaveLength(0);
        } else {
          expect(
            writes.filter((command) => command.type === "deliveryQueue.failPreparation"),
          ).toEqual([
            expect.objectContaining({
              input: { entry: expect.objectContaining({ preparationState: state }) },
            }),
          ]);
        }
      } finally {
        operations.mockRestore();
      }
    },
  );

  it("admits only one modifier owner for a stable intent", async () => {
    const { promise: firstBlocked, resolve: releaseFirst } = createDeferred();
    const { promise: firstStarted, resolve: notifyFirstStarted } = createDeferred();
    const secondRun = vi.fn();

    const first = withStableDeliveryPreparation({
      id: "stable-policy-owner",
      stateDir,
      run: async (owner) => {
        await owner.beforeFirstModifier();
        notifyFirstStarted();
        await firstBlocked;
        await owner.markPrepared();
        return "prepared";
      },
    });
    await firstStarted;
    await expect(
      withStableDeliveryPreparation({
        id: "stable-policy-owner",
        stateDir,
        run: secondRun,
      }),
    ).resolves.toEqual({ status: "existing" });
    expect(secondRun).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toEqual({ status: "claimed", value: "prepared" });
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        "stable-policy-owner",
        stateDir,
      ),
    ).toBe("completed");
  });

  it("releases pre-policy failures but fails closed after modifiers start", async () => {
    await expect(
      withStableDeliveryPreparation({
        id: "retry-before-policy",
        stateDir,
        run: async () => {
          throw new Error("normalization failed");
        },
      }),
    ).rejects.toThrow("normalization failed");
    await expect(
      withStableDeliveryPreparation({
        id: "retry-before-policy",
        stateDir,
        run: async (owner) => {
          await owner.markPrepared();
          return "retried";
        },
      }),
    ).resolves.toEqual({ status: "claimed", value: "retried" });

    await expect(
      withStableDeliveryPreparation({
        id: "fail-after-policy",
        stateDir,
        run: async (owner) => {
          await owner.beforeFirstModifier();
          throw new Error("hook interrupted");
        },
      }),
    ).rejects.toThrow("hook interrupted");
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        "fail-after-policy",
        stateDir,
      ),
    ).toBe("failed");
  });
});
