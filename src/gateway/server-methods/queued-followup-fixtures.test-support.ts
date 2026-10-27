import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { completeFollowupRunLifecycle } from "../../auto-reply/reply/queue/lifecycle.js";
import { readReplySourceInput } from "../../auto-reply/reply/reply-source-binding.js";
import { isSessionControllerWorkActive } from "../../sessions/session-controller.lifecycle.js";
import { bindSessionControllerSource } from "../../sessions/session-controller.mailbox.js";
import { requestRpcSourceCancellation } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";

/** Enqueues a follow-up through the real controller-owned source binding. */
function bindQueuedFollowupRunForTest(
  lifecycle: GetReplyOptions["turnAdoptionLifecycle"],
  prompt: string,
  storePath: string,
) {
  const input = readReplySourceInput({ turnAdoptionLifecycle: lifecycle });
  if (!input) {
    throw new Error("Missing queued chat source");
  }
  const run = createQueueTestRun({ prompt });
  run.run = {
    ...run.run,
    sessionKey: "agent:main:main",
    sessionId: "sess-main",
    agentId: "main",
    config: { ...run.run.config, session: { store: storePath } },
  };
  run.abortSignal = input.abortSignal;
  run.turnAdoptionLifecycle = lifecycle;
  bindSessionControllerSource(input, run);
  const enqueued = enqueueFollowupRun(
    "agent:main:main",
    run,
    createQueueSettings({ mode: "followup" }),
    "none",
    undefined,
    false,
  );
  if (!enqueued) {
    throw new Error("Expected queued follow-up admission");
  }
  return run;
}

/** Binds and observes queued follow-ups in one isolated session-store fixture. */
export function createQueuedFollowupFixtureForTest(storePath: string) {
  return {
    bind: (lifecycle: GetReplyOptions["turnAdoptionLifecycle"], prompt: string) =>
      bindQueuedFollowupRunForTest(lifecycle, prompt, storePath),
    isWorkActive: () => isSessionControllerWorkActive(storePath, ["agent:main:main", "sess-main"]),
  };
}

/** Requests cancellation while leaving settlement to the queued run owner. */
export function requestQueuedFollowupCancellationForTest(runId: string) {
  const source = rpcSourceTesting.get(runId);
  if (!source) {
    throw new Error("Missing queued follow-up source");
  }
  requestRpcSourceCancellation(source);
  return rpcSourceTesting.has(runId);
}

/** Completes the queued controller input and waits for its settlement. */
export async function settleQueuedFollowupRunForTest(
  run: ReturnType<typeof createQueueTestRun> | undefined,
) {
  if (!run) {
    throw new Error("Missing queued follow-up fixture");
  }
  const settlement = run.controllerInput?.settlement;
  if (!settlement) {
    throw new Error("Missing queued follow-up settlement");
  }
  completeFollowupRunLifecycle(run);
  await settlement.promise;
}
