// Stop cannot release an unfinished drain or let its late cleanup consume a successor.
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { captureSessionControllerSourceSettlement } from "../../../sessions/session-controller.mailbox.js";
import { enqueueFollowupRun } from "../queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "../queue.test-helpers.js";
import { clearSessionQueues } from "./cleanup.js";
import { getExistingFollowupQueue } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

installQueueRuntimeErrorSilencer();

it("retains a stopped drain until its raw return and then executes the surviving successor once", async () => {
  const key = "test-drain-exact-owner";
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
  const calls: string[] = [];
  const gate = createDeferred();
  const firstEntered = createDeferred();
  const secondEntered = createDeferred();
  const first = createRun({ prompt: "msg1" });
  const second = createRun({ prompt: "msg2" });
  const runFollowup = async (run: FollowupRun) => {
    calls.push(run.prompt);
    if (run.prompt === "msg1") {
      firstEntered.resolve();
      await gate.promise;
    } else {
      secondEntered.resolve();
    }
  };
  try {
    enqueueFollowupRun(key, first, settings, "message-id", runFollowup);
    await firstEntered.promise;
    const mailbox = first.controllerInput!.mailbox;
    const oldClaim = first.controllerInput!.claim!;
    clearSessionQueues([key]);
    expect(getExistingFollowupQueue(key)).toBe(mailbox);
    enqueueFollowupRun(key, second, settings, "message-id", runFollowup);
    expect(second.controllerInput!.mailbox).toBe(mailbox);
    expect(second.controllerInput!.abortSignal.aborted).toBe(false);
    expect(calls).toEqual(["msg1"]);

    gate.resolve();
    await oldClaim.settlement.promise;
    await secondEntered.promise;
    await captureSessionControllerSourceSettlement(second.controllerInput!);
    await second.controllerInput!.claim?.settlement.promise;
    expect(calls).toEqual(["msg1", "msg2"]);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  } finally {
    gate.resolve();
    clearSessionQueues([key]);
    await Promise.allSettled(
      [first, second].flatMap((source) =>
        source.controllerInput
          ? [captureSessionControllerSourceSettlement(source.controllerInput)]
          : [],
      ),
    );
  }
});
