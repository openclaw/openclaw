import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { admitFollowupRunLifecycle } from "../../auto-reply/reply/queue/lifecycle.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { QueuedFollowupReplyBatch } from "../../auto-reply/reply/queue/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  attachSessionControllerInputOperation,
  bindSessionControllerSource,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import {
  isRpcSourceQueued,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { prepareAgentWaitForTurn } from "../agent-turn/agent-wait.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";

const sessionKey = "agent:main:queued-identity";
const identity = { sessionKey, sessionId: "session", agentId: "main" };
const target = captureSessionTarget({
  storeScope: "/synthetic/queued-identity/sessions",
  sessionKey,
  incarnation: "session",
  agentId: "main",
});
const ownedSources: RpcSourceRef[] = [];
const ownedOperations: ReplyOperation[] = [];

function replyBatch(
  runId: string,
  completion: QueuedFollowupReplyBatch["completion"],
  payloads: QueuedFollowupReplyBatch["payloads"] = [],
  originatingChannel = "webchat",
): QueuedFollowupReplyBatch {
  return { kind: "queued-followup", runId, originatingChannel, payloads, completion };
}

afterEach(async () => {
  clearFollowupQueue(sessionKey);
  ownedOperations.splice(0).forEach((operation) => operation.complete());
  const sources = ownedSources.splice(0);
  for (const source of sources) {
    if (source.input.claim) {
      releaseSessionControllerClaim(source.input.claim);
    }
    retireSessionControllerInput(source.input);
  }
  await Promise.allSettled(sources.map((source) => source.input.settlement.promise));
  clearRuntimeConfigSnapshot();
});

function fixture(originatingChannel = "webchat") {
  const cfg = {};
  setRuntimeConfigSnapshot(cfg);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  async function waitResult(runId: string) {
    return (await prepareAgentWaitForTurn(context, { runId, timeoutMs: 0 }).wait()).result;
  }
  function enqueue(runId: string, dropPolicy: "old" | "new" = "old", cap = 10) {
    const registration = registerChatAbortController({
      target,
      runId,
      ...identity,
      timeoutMs: 10_000,
    });
    if (!registration.registered) {
      throw new Error("Expected a new queued source");
    }
    const { controller, entry: sourceRef } = registration;
    ownedSources.push(sourceRef);
    const adoption = createChatSendTurnAdoptionLifecycle({
      accountId: undefined,
      context,
      sourceRef,
      runId,
      controller,
      sessionKey,
      agentId: "main",
      originatingChannel,
      session: {
        agentId: "main",
        backingSessionId: "session",
        cfg,
        clientRunId: runId,
        sessionKey,
        sessionLoadOptions: { agentId: "main" },
      },
      hasCronCreatorAuthority: false,
      releaseSourceWorkAdmission: vi.fn(),
      retainWorkAdmission: () => vi.fn(),
    });
    const run = {
      ...createQueueTestRun({ prompt: runId, originatingChannel }),
      abortSignal: controller.signal,
      turnAdoptionLifecycle: adoption.lifecycle,
      onQueueDisposition: adoption.onQueueDisposition,
      queuedFollowupReplyDisposition: {
        kind: "deliver" as const,
        deliver: adoption.onQueuedFollowupReplyBatch,
      },
    };
    bindSessionControllerSource(sourceRef.input, run);
    enqueueFollowupRun(
      sessionKey,
      run,
      { mode: "collect", debounceMs: 0, cap, dropPolicy },
      "none",
      undefined,
      false,
    );
    return { run, adoption, controller, sourceRef };
  }
  const terminals = () =>
    vi
      .mocked(context.broadcast)
      .mock.calls.flatMap(([event, payload]) => (event === "chat" ? [payload] : []));
  const execution = async (sources: ReturnType<typeof enqueue>[] = []) => {
    const mailboxClaim = sources[0] ? await claimSessionControllerInput(sources[0].run) : undefined;
    const operation = createReplyOperation({
      mailboxClaim,
      target,
      ...identity,
      resetTriggered: false,
    });
    ownedOperations.push(operation);
    for (const queuedSource of sources) {
      attachSessionControllerInputOperation(queuedSource.run, operation);
    }
    return operation;
  };
  return { context, enqueue, terminals, execution, waitResult };
}

it("settles failed progress without retiring its transferred recovery delivery", async () => {
  const { context, enqueue, terminals } = fixture();
  const { adoption } = enqueue("progress-failure-B");
  const getRuntimeConfig = context.getRuntimeConfig;
  const failPreparation = () => {
    context.getRuntimeConfig = getRuntimeConfig;
    throw new Error("progress preparation failed");
  };
  context.getRuntimeConfig = failPreparation;
  const batch = replyBatch("progress-C", { kind: "progress" }, [{ text: "working" }]);
  await expect(adoption.onQueuedFollowupReplyBatch(batch)).rejects.toThrow(
    "progress preparation failed",
  );
  expect(terminals()).toEqual([]);
  expect(context.dedupe.get("chat:progress-failure-B")?.payload).toMatchObject({
    status: "accepted",
  });
  const retry = expectDefined(
    adoption.onQueuedFollowupReplyBatch.createSourceRetry,
    "transferred recovery delivery",
  )();
  context.getRuntimeConfig = failPreparation;
  await expect(
    adoption.onQueuedFollowupReplyBatch({
      ...batch,
      payloads: [],
      completion: { kind: "failed", error: "progress preparation failed" },
    }),
  ).rejects.toThrow("progress preparation failed");
  expect(terminals()).toMatchObject([{ runId: "progress-failure-B", state: "error" }]);
  await retry(replyBatch("recovery-C", { kind: "completed" }));
  expect(terminals()).toMatchObject([
    { runId: "progress-failure-B", state: "error" },
    { runId: "recovery-C", state: "final" },
  ]);
});

it("withdraws only the selected input before consumption", async () => {
  const { context, enqueue, terminals, execution } = fixture();
  const active = await execution();
  const first = enqueue("cancel-B1");
  const second = enqueue("cancel-B2");
  const releaseFirst = vi.fn();
  const releaseSecond = vi.fn();
  context.chatRunState.getOrCreate("cancel-B1").releaseBufferAuthority = releaseFirst;
  context.chatRunState.getOrCreate("cancel-B2").releaseBufferAuthority = releaseSecond;
  expect(requestRpcSourceCancellation(first.sourceRef, createAgentRunDirectAbortError())).toBe(
    true,
  );
  expect(first.controller.signal.aborted).toBe(true);
  expect(second.controller.signal.aborted).toBe(false);
  expect(active.abortSignal.aborted).toBe(false);
  expect(isRpcSourceQueued(second.sourceRef)).toBe(true);
  expect(terminals()).toMatchObject([{ runId: "cancel-B1", state: "aborted" }]);
  expect(releaseFirst).toHaveBeenCalledOnce();
  expect(releaseSecond).not.toHaveBeenCalled();
  expect(context.chatRunState.runs.get("cancel-B1")?.releaseBufferAuthority).toBeUndefined();
});

it.each([1, 2])("waits for %i consumed inputs to settle after cancellation", async (count) => {
  const { context, enqueue, terminals, execution } = fixture();
  const source = enqueue(`running-B-${count}`);
  const primary = count === 1 ? source : enqueue(`primary-B-${count}`);
  await execution(primary === source ? [source] : [source, primary]);
  await admitFollowupRunLifecycle(source.run);
  if (primary !== source) {
    await admitFollowupRunLifecycle(primary.run);
  }
  primary.adoption.onRunStarted("running-C");
  requestRpcSourceCancellation(source.sourceRef, createAgentRunDirectAbortError());
  expect(terminals()).toEqual([]);
  expect(context.dedupe.get(`chat:running-B-${count}`)?.payload).toMatchObject({
    status: "accepted",
  });
  await source.adoption.onQueuedFollowupReplyBatch(
    replyBatch("running-C", { kind: "aborted", stopReason: "aborted" }),
  );
  expect(terminals()).toMatchObject([{ runId: `running-B-${count}`, state: "aborted" }]);
});

it("keeps external-channel streaming separate from the input terminal", async () => {
  const { context, enqueue, terminals } = fixture("discord");
  const { adoption } = enqueue("channel-B");
  await adoption.lifecycle.onAdopted();
  adoption.onRunStarted("channel-C");
  expect(context.addChatRun).not.toHaveBeenCalled();
  const batch = replyBatch(
    "channel-C",
    { kind: "progress" },
    [{ text: "channel reply" }],
    "discord",
  );
  await adoption.onQueuedFollowupReplyBatch(batch);
  expect(terminals()).toEqual([]);
  await adoption.onQueuedFollowupReplyBatch({ ...batch, completion: { kind: "completed" } });
  expect(terminals()).toMatchObject([{ runId: "channel-B", state: "final", message: undefined }]);
});

it.each(["old", "new"] as const)(
  "terminalizes the dropped input with overflow policy %s",
  async (dropPolicy) => {
    const { context, enqueue, terminals, waitResult } = fixture();
    const first = `overflow-first-${dropPolicy}`;
    enqueue(first, dropPolicy, 1);
    const releaseFirst = vi.fn();
    context.chatRunState.getOrCreate(first).releaseBufferAuthority = releaseFirst;
    enqueue(`overflow-second-${dropPolicy}`, dropPolicy, 1);
    expect(releaseFirst).toHaveBeenCalledTimes(dropPolicy === "old" ? 1 : 0);
    if (dropPolicy === "old") {
      expect(context.chatRunState.runs.get(first)?.releaseBufferAuthority).toBeUndefined();
    }
    const dropped = `overflow-${dropPolicy === "old" ? "first" : "second"}-${dropPolicy}`;
    expect(terminals()).toMatchObject([
      {
        runId: dropped,
        state: "error",
        errorMessage: expect.stringContaining("dropped"),
      },
    ]);
    expect(await waitResult(dropped)).toMatchObject({ runId: dropped, status: "error" });
  },
);
