import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { collectRuntimeMetadata } from "../../auto-reply/reply/queue/delivery-context.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
} from "../../auto-reply/reply/queue/lifecycle.js";
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
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { prepareAgentWaitForTurn } from "../agent-turn/agent-wait.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";

const sessionKey = "agent:main:queued-identity";
const target = captureSessionTarget({
  storeScope: "/synthetic/queued-identity/sessions",
  sessionKey,
  incarnation: "session",
  agentId: "main",
});
const ownedSources: RpcSourceRef[] = [];
const ownedOperations: ReplyOperation[] = [];
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
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
  });
  function source(runId: string) {
    const registration = registerChatAbortController({
      target,
      runId,
      sessionKey,
      sessionId: "session",
      agentId: "main",
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
    return { run, adoption, controller, sourceRef };
  }
  const enqueue = (runId: string, dropPolicy: "old" | "new" = "old", cap = 10) => {
    const item = source(runId);
    enqueueFollowupRun(
      sessionKey,
      item.run,
      { mode: "collect", debounceMs: 0, cap, dropPolicy },
      "none",
      undefined,
      false,
    );
    return item;
  };
  const terminals = () =>
    vi
      .mocked(context.broadcast)
      .mock.calls.flatMap(([event, payload]) => (event === "chat" ? [payload] : []));
  const execution = async (sources: ReturnType<typeof source>[] = []) => {
    const mailboxClaim = sources[0] ? await claimSessionControllerInput(sources[0].run) : undefined;
    const operation = createReplyOperation({
      mailboxClaim,
      target,
      sessionKey,
      sessionId: "session",
      agentId: "main",
      resetTriggered: false,
    });
    ownedOperations.push(operation);
    for (const queuedSource of sources) {
      attachSessionControllerInputOperation(queuedSource.run, operation);
    }
    return operation;
  };
  return { context, enqueue, terminals, execution };
}

describe("queued chat input identity", () => {
  it.each([
    { completion: { kind: "completed" }, state: "final", status: "ok" },
    { completion: { kind: "failed", error: "Provider failed" }, state: "error", status: "error" },
    {
      completion: {
        kind: "failed",
        error: "Provider timed out",
        errorKind: "timeout",
        stopReason: "timeout",
      },
      state: "error",
      status: "timeout",
    },
    { completion: { kind: "aborted", stopReason: "rpc" }, state: "aborted", status: "error" },
  ] satisfies Array<{
    completion: QueuedFollowupReplyBatch["completion"];
    state: string;
    status: string;
  }>)(
    "settles every collected input only with the execution's $completion.kind outcome",
    async ({ completion, state, status }) => {
      const { context, enqueue, terminals } = fixture();
      const ids = [`input-1-${completion.kind}-${status}`, `input-2-${completion.kind}-${status}`];
      const inputs = ids.map((id) => enqueue(id));
      expect(terminals()).toEqual([]);
      for (const id of ids) {
        expect(context.dedupe.get(`chat:${id}`)?.payload).toMatchObject({
          runId: id,
          status: "accepted",
        });
        expect(
          (await prepareAgentWaitForTurn(context, { runId: id, timeoutMs: 0 }).wait()).result
            .status,
        ).toBe("pending");
      }
      const collected = collectRuntimeMetadata(inputs.map(({ run }) => run));
      expect(collected.queuedFollowupReplyDisposition?.kind).toBe("deliver");
      if (collected.queuedFollowupReplyDisposition?.kind !== "deliver") {
        throw new Error("missing collected delivery owner");
      }
      const batch: QueuedFollowupReplyBatch = {
        kind: "queued-followup",
        runId: "execution-C",
        originatingChannel: "webchat",
        payloads: [],
        completion,
      };
      await Promise.all([
        collected.queuedFollowupReplyDisposition.deliver(batch),
        collected.queuedFollowupReplyDisposition.deliver(batch),
      ]);
      inputs.forEach(({ run }) => completeFollowupRunLifecycle(run));
      expect(terminals()).toEqual(ids.map((runId) => expect.objectContaining({ runId, state })));
      expect(ids.every((id) => !isRpcSourceQueued(rpcSourceTesting.get(id)))).toBe(true);
      for (const id of ids) {
        expect(
          (await prepareAgentWaitForTurn(context, { runId: id, timeoutMs: 0 }).wait()).result,
        ).toMatchObject({ runId: id, status });
      }
    },
  );

  it("keeps a progress presentation failure open until the execution terminal", async () => {
    const { context, enqueue, terminals } = fixture();
    const { adoption } = enqueue("progress-failure-B");
    const getRuntimeConfig = context.getRuntimeConfig;
    const failPreparation = () => {
      context.getRuntimeConfig = getRuntimeConfig;
      throw new Error("progress preparation failed");
    };
    context.getRuntimeConfig = failPreparation;
    const batch: QueuedFollowupReplyBatch = {
      kind: "queued-followup",
      runId: "progress-C",
      originatingChannel: "webchat",
      payloads: [{ text: "working" }],
      completion: { kind: "progress" },
    };
    await expect(adoption.onQueuedFollowupReplyBatch(batch)).rejects.toThrow(
      "progress preparation failed",
    );
    expect(terminals()).toEqual([]);
    expect(context.dedupe.get("chat:progress-failure-B")?.payload).toMatchObject({
      status: "accepted",
    });
    context.getRuntimeConfig = failPreparation;
    await expect(
      adoption.onQueuedFollowupReplyBatch({
        ...batch,
        payloads: [],
        completion: { kind: "failed", error: "progress preparation failed" },
      }),
    ).rejects.toThrow("progress preparation failed");
    expect(terminals()).toEqual([
      expect.objectContaining({ runId: "progress-failure-B", state: "error" }),
    ]);
  });

  it("withdraws only the selected input before consumption", async () => {
    const { enqueue, terminals, execution } = fixture();
    const active = await execution();
    const first = enqueue("cancel-B1");
    const second = enqueue("cancel-B2");
    expect(requestRpcSourceCancellation(first.sourceRef, createAgentRunDirectAbortError())).toBe(
      true,
    );
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    expect(active.abortSignal.aborted).toBe(false);
    expect(isRpcSourceQueued(second.sourceRef)).toBe(true);
    expect(terminals()).toEqual([
      expect.objectContaining({ runId: "cancel-B1", state: "aborted" }),
    ]);
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
    await source.adoption.onQueuedFollowupReplyBatch({
      kind: "queued-followup",
      runId: "running-C",
      originatingChannel: "webchat",
      payloads: [],
      completion: { kind: "aborted", stopReason: "aborted" },
    });
    expect(terminals()).toEqual([
      expect.objectContaining({ runId: `running-B-${count}`, state: "aborted" }),
    ]);
  });

  it("keeps external-channel streaming separate from the input terminal", async () => {
    const { context, enqueue, terminals } = fixture("discord");
    const { adoption } = enqueue("channel-B");
    await adoption.lifecycle.onAdopted();
    adoption.onRunStarted("channel-C");
    expect(context.addChatRun).not.toHaveBeenCalled();
    await adoption.onQueuedFollowupReplyBatch({
      kind: "queued-followup",
      runId: "channel-C",
      originatingChannel: "discord",
      payloads: [{ text: "channel reply" }],
      completion: { kind: "progress" },
    });
    expect(terminals()).toEqual([]);
    await adoption.onQueuedFollowupReplyBatch({
      kind: "queued-followup",
      runId: "channel-C",
      originatingChannel: "discord",
      payloads: [{ text: "channel reply" }],
      completion: { kind: "completed" },
    });
    expect(terminals()).toEqual([
      expect.objectContaining({ runId: "channel-B", state: "final", message: undefined }),
    ]);
  });

  it.each(["old", "new"] as const)(
    "terminalizes the dropped input with overflow policy %s",
    async (dropPolicy) => {
      const { context, enqueue, terminals } = fixture();
      enqueue(`overflow-first-${dropPolicy}`, dropPolicy, 1);
      enqueue(`overflow-second-${dropPolicy}`, dropPolicy, 1);
      const dropped = `overflow-${dropPolicy === "old" ? "first" : "second"}-${dropPolicy}`;
      expect(terminals()).toEqual([
        expect.objectContaining({
          runId: dropped,
          state: "error",
          errorMessage: expect.stringContaining("dropped"),
        }),
      ]);
      expect(
        (await prepareAgentWaitForTurn(context, { runId: dropped, timeoutMs: 0 }).wait()).result,
      ).toMatchObject({ runId: dropped, status: "error" });
    },
  );
});
