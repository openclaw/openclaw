import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
} from "./deliver.queue-integration.test-support.js";
import { installRecoveryHooks } from "./delivery-completion.shard-test-support.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { loadPendingDeliveries } from "./delivery-queue.test-helpers.js";

const fixtures = installRecoveryHooks(true, false);

it("restores a reserved row when shutdown wins before provider dispatch", async () => {
  const tmpDir = fixtures.tmpDir();
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  const intentIds = ["lifecycle-fence-a", "lifecycle-fence-b"];
  for (const id of intentIds) {
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: id }],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
        maxRetries: 2,
      },
      id,
      tmpDir,
    );
  }
  const secondBefore = (await loadPendingDeliveries(tmpDir)).find(
    (entry) => entry.id === intentIds[1],
  );
  const { promise: secondPreparedPromise, resolve: secondPrepared } = createDeferred();
  const { promise: secondBlocked, resolve: releaseSecond } = createDeferred();
  const sendMatrix = vi.fn().mockResolvedValue({ messageId: "sent-before-stop" });
  const deliver = vi.fn<DeliverFn>(async (params) => {
    if (deliver.mock.calls.length === 2) {
      secondPrepared();
      await secondBlocked;
    }
    return fixtures.deliver({ ...params, deps: { matrix: sendMatrix } });
  });
  let shouldContinue = true;

  const drain = drainMatrixReconnect({
    deliver,
    stateDir: tmpDir,
    shouldContinue: () => shouldContinue,
  });
  try {
    await awaitGateBeforeSettlement(
      secondPreparedPromise,
      drain,
      "Recovery drain completed before the second attempt prepared",
    );

    shouldContinue = false;
    releaseSecond();
    await drain;

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(
      (await loadPendingDeliveries(tmpDir)).find((entry) => entry.id === intentIds[1]),
    ).toEqual(secondBefore);
  } finally {
    releaseSecond();
    await drain.catch(() => undefined);
  }
});
