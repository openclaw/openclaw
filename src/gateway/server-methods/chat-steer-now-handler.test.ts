import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  captureAgent,
  makeCall,
  makeTool,
  user,
} from "../../../packages/agent-core/src/agent-loop.test-support.js";
import type { ChatPendingInputsPage } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  createPendingSteerToolControl,
  steerActiveSessionWithOptionalDeliveryWait,
} from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { setSteeringMessageIdentity } from "../../agents/sessions/steering-message-identity.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { scheduleFollowupDrain } from "../../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  stageSessionPendingInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  createReplyOperation,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import {
  bindSessionControllerSource,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import {
  beginSessionControllerSteer,
  sendSessionControllerSteerNow,
} from "../../sessions/session-controller.steer.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

async function fixture(interruptible: boolean, signal: AbortSignal, fallback = false) {
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("write", "steer-owner");
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:steer-now",
    sessionId: "steer-now-session",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    createdActor: {
      type: "human",
      source: "profile",
      id: expectDefined(client.authenticatedUserProfile, "profile").profileId,
    },
  });
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  const entered = createDeferred<AbortSignal>();
  const released = createDeferred();
  const cleanup = createDeferred();
  const { agent, requests } = captureAgent(
    [
      {
        ...makeTool("held_tool"),
        interruptible: interruptible ? true : undefined,
        execute: async (_id, _args, toolSignal) => {
          const current = expectDefined(toolSignal, "tool cancellation");
          current.addEventListener("abort", () => released.resolve(), { once: true });
          entered.resolve(current);
          await withinTest(released.promise, signal);
          await withinTest(cleanup.promise, signal);
          return { content: [{ type: "text", text: "settled" }], details: {} };
        },
      },
    ],
    {},
    [[makeCall("held_tool")], [{ type: "text", text: "done" }]],
  );
  const run = agent.prompt("Start synthetic work.");
  const toolSignal = await withinTest(entered.promise, signal);
  const target = captureSessionTarget({
    ...scope,
    storeScope: scope.storePath,
    incarnation: scope.sessionId,
  });
  const operation = createReplyOperation({ ...scope, target, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn();
  const interruption = vi.spyOn(agent, "interruptTools");
  const activeSession = {
    agent,
    steer: async (
      text: string,
      _images: unknown,
      _recorder: unknown,
      _media: unknown,
      _order: unknown,
      identity?: string,
    ) => {
      const queued = user(text);
      setSteeringMessageIdentity(queued, identity);
      agent.steer(queued);
    },
    subscribe: (
      listener: Parameters<
        Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[0]["subscribe"]
      >[0],
    ) =>
      agent.subscribe((event) => {
        if (event.type !== "agent_end") {
          return listener(event);
        }
        return undefined;
      }),
  };
  operation.attachBackend({
    kind: "embedded",
    runId: "active-steer-run",
    cancel,
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, options, assertCurrent) => {
        assertCurrent();
        return steerActiveSessionWithOptionalDeliveryWait(activeSession, text, options);
      },
      steerNow: createPendingSteerToolControl(activeSession, () => !operation.result),
    },
  });
  const runId = "pending-steer";
  const receipt = expectDefined(
    await stageSessionPendingInput(scope, {
      runId,
      message: {
        role: "user",
        content: "Use the correction.",
        timestamp: 1,
        idempotencyKey: `${runId}:user`,
      },
      requestFingerprint: "c".repeat(64),
      assertCurrent() {},
    }),
    "pending receipt",
  );
  const input = reserveSessionControllerSource(scope.sessionKey, {
    target,
    protocolRunId: runId,
    policy: { mode: "steer" },
  });
  registerRpcSource(runId, { input, adapter: { kind: "chat-send" } });
  if (fallback) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
  const steerTarget = expectDefined(captureReplyMessageInjectionTarget(operation), "active target");
  const prepareRetry = vi.fn(async () => {});
  const start = async (
    assertCurrent?: () => void,
  ): ReturnType<typeof beginSessionControllerSteer> => {
    if (assertCurrent) {
      await prepareRetry();
    }
    return beginSessionControllerSteer({
      input,
      target: steerTarget,
      retry: start,
      retryWithdrawnSteer: assertCurrent !== undefined,
      text: "Use the correction.",
      options: { waitForTranscriptCommit: true, assertCurrent },
    });
  };
  const attempt = expectDefined(await start(), "steering attempt");
  expect(await attempt.acceptance).toBe(true);
  const dispatch = vi.fn(async (followup: ReturnType<typeof createQueueTestRun>) => {
    await agent.prompt(user(followup.prompt));
  });
  const adopted = vi.fn();
  const abandoned = vi.fn();
  if (fallback) {
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await attempt.outcome).toMatchObject({
        status: "rejected",
        reason: "injection_unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
    const followup = createQueueTestRun({
      prompt: "Use the correction.",
      turnAdoptionLifecycle: { onAdopted: adopted, onAbandoned: abandoned },
    });
    followup.run = { ...followup.run, ...scope };
    bindSessionControllerSource(input, followup);
    expect(
      enqueueFollowupRun(
        scope.sessionKey,
        followup,
        { mode: "followup", debounceMs: 0 },
        "none",
        dispatch,
        false,
      ),
    ).toBe(true);
  }
  return {
    agent,
    requests,
    toolSignal,
    interruption,
    cancel,
    operation,
    run,
    attempt,
    client,
    context,
    scope,
    released,
    cleanup,
    dispatch,
    adopted,
    abandoned,
    input,
    prepareRetry,
    async finishRun() {
      await withinTest(run, signal);
      if (fallback) {
        operation.complete();
        scheduleFollowupDrain(scope.sessionKey, dispatch, input.mailbox.owner);
        await withinTest(input.settlement.promise, signal);
      }
    },
    page: async () => {
      const [ok, result] = await chatRpc(context, client, "chat.history", {
        sessionKey: scope.sessionKey,
        agentId: scope.agentId,
      });
      expect(ok).toBe(true);
      return (result as { pendingInputs: ChatPendingInputsPage }).pendingInputs;
    },
    send: (caller = client, params: Record<string, unknown> = {}) =>
      chatRpc(context, caller, "chat.steerNow", {
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        runId,
        ...params,
      }),
    async [Symbol.asyncDispose]() {
      released.resolve();
      cleanup.resolve();
      await run;
      await attempt.outcome;
      operation.complete();
      retireSessionControllerInput(input);
      receipt.finish("cancelled");
      await receipt.settled?.();
      await disposeSessionReadContexts();
    },
  };
}

it.for([false, true])(
  "interrupts tools once and delivers one input after fallback=%s",
  async (fallback, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      await using f = await fixture(true, signal, fallback);
      expect((await f.page()).items[0]?.steerNow).toEqual({
        status: "available",
        tools: ["held_tool"],
      });
      const sends = await Promise.all([f.send(), f.send()]);
      for (const result of sends) {
        expect(result).toEqual([true, { status: "interrupted", tools: ["held_tool"] }]);
      }
      expect(f.toolSignal.aborted).toBe(true);
      expect(f.agent.state.messages.some((message) => message.role === "toolResult")).toBe(false);
      expect(await f.send()).toEqual([true, { status: "interrupted", tools: ["held_tool"] }]);
      expect(f.interruption).toHaveBeenCalledOnce();
      expect(f.prepareRetry).toHaveBeenCalledTimes(fallback ? 1 : 0);
      f.cleanup.resolve();
      await f.finishRun();
      await f.attempt.outcome;
      expect(f.requests.at(-1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            isError: true,
            content: [
              { type: "text", text: "settled" },
              { type: "text", text: "Interrupted by the user to send a pending message." },
            ],
            details: { status: "interrupted", reason: "user_steer", partialResult: {} },
          }),
          expect.objectContaining({ role: "user", content: "Use the correction." }),
        ]),
      );
      expect(f.agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
      expect(f.operation.abortSignal.aborted).toBe(false);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(
        f.agent.state.messages.filter(
          (message) => message.role === "user" && message.content === "Use the correction.",
        ),
      ).toHaveLength(1);
      expect(f.requests).toHaveLength(2);
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.adopted).toHaveBeenCalledTimes(fallback ? 1 : 0);
      expect(f.abandoned).not.toHaveBeenCalled();
      expect(await f.send()).toEqual([true, { status: "settled", tools: [] }]);
      expect((await f.page()).items[0]?.steerNow).toBeUndefined();
    });
  },
);

it("rechecks the requesting writer after preparing a fallback retry", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await using f = await fixture(true, signal, true);
    const preparing = createDeferred();
    const release = createDeferred();
    f.prepareRetry.mockImplementation(async () => {
      preparing.resolve();
      await release.promise;
    });
    let current = true;
    const sending = sendSessionControllerSteerNow(f.input, () => {
      if (!current) {
        throw new Error("Writer authority changed");
      }
    });
    const rejected = expect(sending).rejects.toThrow("Writer authority changed");
    await withinTest(preparing.promise, signal);
    current = false;
    release.resolve();
    await rejected;
    expect(f.toolSignal.aborted).toBe(false);
    expect(f.interruption).not.toHaveBeenCalled();
    expect((await f.page()).items[0]).toMatchObject({ state: "queued", queued: true });
  });
});

it("keeps fallback tool and writer checks and cannot interrupt a replacement backend", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await using f = await fixture(false, signal, true);
    expect((await f.page()).items[0]?.steerNow).toEqual({
      status: "blocked",
      tools: ["held_tool"],
    });
    for (const role of ["view", "none"] as const) {
      expect((await f.send(roleClient(role, `steer-${role}`)))[0]).toBe(false);
    }
    const readOnly = { ...f.client, connect: { ...f.client.connect, scopes: ["operator.read"] } };
    expect(await f.send(readOnly)).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    expect(await f.send(f.client, { sessionId: "replaced" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST" },
    ]);
    expect((await f.send(f.client, { sessionKey: "agent:main:foreign" }))[0]).toBe(false);
    expect(f.interruption).not.toHaveBeenCalled();
    expect(await f.send()).toEqual([true, { status: "blocked", tools: ["held_tool"] }]);
    const ownSessionWriter = {
      ...f.client,
      connect: {
        ...f.client.connect,
        scopes: ["operator.sessions.read", "operator.sessions.write"],
      },
    };
    expect(await f.send(ownSessionWriter)).toEqual([
      true,
      { status: "blocked", tools: ["held_tool"] },
    ]);
    const otherWriter = roleClient("write", "steer-other-writer");
    otherWriter.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    expect(await f.send(otherWriter)).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    expect(f.toolSignal.aborted).toBe(false);
    expect(f.cancel).not.toHaveBeenCalled();
    f.operation.attachBackend({
      kind: "embedded",
      runId: "replacement",
      cancel() {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async () => {},
        steerNow: {
          read: () => ({ status: "available", tools: ["replacement"] }),
          send: () => {
            throw new Error("Must not interrupt a replacement backend");
          },
        },
      },
    });
    expect(await f.send()).toEqual([true, { status: "settled", tools: [] }]);
  });
});
