import { performance } from "node:perf_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  createReplyOperation,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import type { ChatHistoryPage } from "../../config/sessions/session-history-types.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookInputRouteContext,
  PluginHookInputRouteEvent,
  PluginHookInputRouteResult,
} from "../../plugins/hook-types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { handleGatewayRequest } from "../server-methods.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

const { readHistory } = vi.hoisted(() => ({
  readHistory: vi.fn<(...args: unknown[]) => Promise<ChatHistoryPage>>(),
}));
vi.mock("../../config/sessions/session-history-worker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../config/sessions/session-history-worker-runtime.js")
  >()),
  readSessionHistoryPageInWorker: readHistory,
}));

vi.mock("../../decisions/runtime.js", () => ({
  inspectDecisionProviders: () => [
    {
      providerId: "test-provider",
      pluginId: "test-provider",
      callable: true,
      runtimeGeneration: "fixture",
    },
  ],
}));

installGatewayTestHooks({ scope: "suite" });
const createBrowserFollowupFixture = useBrowserFollowupFixture();
afterEach(() => vi.useRealTimers());

type Dispatch = Parameters<typeof dispatchInboundMessage>[0];
type Decision = (
  event: PluginHookInputRouteEvent,
  context: PluginHookInputRouteContext,
) => Promise<PluginHookInputRouteResult>;

function setDecisionAssistance(enabled: boolean) {
  const config = getRuntimeConfig();
  setRuntimeConfigSnapshot({
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        experimental: { ...config.agents?.defaults?.experimental, decisionAssistance: enabled },
        decisionModel: "test-provider/decision-model",
      },
    },
  });
}

async function createAutoFixture() {
  const fixture = await createBrowserFollowupFixture({ preserveContent: true });
  setDecisionAssistance(true);
  const operation = fixture.activeRun;
  if (!operation) {
    throw new Error("Expected the real active reply owner");
  }
  // Freeze only the optional-work clock. SQLite and admission still use their real owners.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const decide = vi.fn<Decision>().mockResolvedValue({ status: "choice", choice: "steer" });
  const registry = getTestPluginRegistry();
  registry.typedHooks.push({
    pluginId: "auto-route-fixture",
    source: "test",
    hookName: "input_route",
    handler: decide,
  });
  initializeGlobalHookRunner(registry);
  readHistory.mockReset().mockResolvedValue({
    messages: [
      {
        role: "user",
        content: "Keep working on the current task.",
        idempotencyKey: "source-turn:user",
      },
      { role: "assistant", content: "I am checking the current change." },
    ],
  });
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => "auto-tools",
    project: () => "auto-tools",
  });
  operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
  operation.setPhase("running");
  replyRunRegistry.bindSourceTurnId(operation, "source-turn");
  const delivered: string[] = [];
  const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
    async (_text, options, assertCurrent) => {
      assertCurrent();
      options?.onQueueAccepted?.(true);
      const committed = await options?.userTurnTranscriptRecorder?.persistApproved();
      if (!committed) {
        throw new Error("The guarded runtime did not receive approved input custody");
      }
      const committedText = extractTextFromChatContent(committed.message.content, {
        normalizeText: (text) => text,
      });
      if (committedText === null) {
        throw new Error("Expected committed user text");
      }
      delivered.push(committedText);
    },
  );
  operation.attachBackend({
    kind: "embedded",
    runId: "auto-backing-run",
    toolAuthorityFingerprint: "auto-tools",
    cancel: vi.fn(),
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
  });
  expect(
    replyRunRegistry.resolveCurrentMessageInjectionTarget(fixture.scope.sessionKey),
  ).toMatchObject({ sourceTurnId: "source-turn" });

  const dispatches: Dispatch[] = [];
  const dispatchRelease = createDeferred();
  const dispatchEntered = createDeferred<Dispatch>();
  // This is the existing fixture's execution seam, not a replacement chat/admission handler.
  dispatchInboundMessageMock.mockImplementation(async (value: unknown) => {
    const params = value as Dispatch;
    dispatches.push(params);
    dispatchEntered.resolve(params);
    await dispatchRelease.promise;
    await params.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    return {};
  });
  const requests: Promise<unknown>[] = [];
  const send = (id: string, message: string, overrides: Partial<typeof fixture.params> = {}) => {
    // Concurrent requests must not share the fixture's mutable params object.
    const params = {
      ...fixture.params,
      deliveryPolicy: "auto" as const,
      queueMode: "followup" as const,
      ...overrides,
      idempotencyKey: id,
      message,
    };
    const respond = vi.fn<RespondFn>();
    const done = handleGatewayRequest({
      req: { type: "req", id, method: "chat.send", params },
      client: fixture.client,
      context: fixture.context,
      respond,
      isWebchatConnect: () => true,
      extraHandlers: { "chat.send": handleChatSend },
    }).then(() => respond);
    requests.push(done);
    return done;
  };
  const drain = () =>
    getSessionWorkAdmissionRelease({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
    });
  return {
    ...fixture,
    clock,
    operation,
    decide,
    queueMessage,
    delivered,
    dispatches,
    dispatchEntered,
    dispatchRelease,
    send,
    drain,
    cleanup: async () => {
      operation.abortByUser();
      dispatchRelease.resolve();
      for (const dispatch of dispatches) {
        dispatch.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
      }
      await Promise.allSettled(requests);
      await drain();
      operation.complete();
      dispatchInboundMessageMock.mockReset();
      clock.mockRestore();
      vi.useRealTimers();
    },
  };
}

function deferredDecision() {
  return {
    entered: createDeferred<PluginHookInputRouteContext>(),
    result: createDeferred<PluginHookInputRouteResult>(),
  };
}

function expectStarted(response: ReturnType<typeof vi.fn<RespondFn>>, runId: string) {
  expect(response).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ runId, status: "started" }),
    undefined,
    expect.anything(),
  );
}

describe("Auto through real chat.send admission and custody", () => {
  it("does no optional work with the gate off, and routes classified input independently of the manual baseline", async () => {
    const fixture = await createAutoFixture();
    try {
      setDecisionAssistance(false);
      expectStarted(await fixture.send("gate-off", "Leave this for later."), "gate-off");
      const baseline = await fixture.dispatchEntered.promise;
      expect(baseline.replyOptions?.queueModeOverride).toBe("followup");
      expect(readHistory).not.toHaveBeenCalled();
      expect(fixture.decide).not.toHaveBeenCalled();
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      expect(listSessionPendingInputs(fixture.scope).items[0]?.message).not.toHaveProperty(
        "__openclaw.autoSteer",
      );
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      fixture.dispatchRelease.resolve();
      await fixture.drain();

      setDecisionAssistance(true);
      expectStarted(
        await fixture.send("classified-steer", "Use the smaller change instead."),
        "classified-steer",
      );
      await fixture.drain();
      expect(fixture.queueMessage).toHaveBeenCalledOnce();
      expect(fixture.delivered).toEqual(["Use the smaller change instead."]);
      expect(fixture.dispatches).toHaveLength(1);
      expect(fixture.decide.mock.calls[0]?.[0]).toEqual({
        currentTurn: [
          { role: "user", text: "Keep working on the current task." },
          { role: "assistant", text: "I am checking the current change." },
        ],
        newMessage: "Use the smaller change instead.",
      });
      expect(loadTranscriptEventsSync(fixture.scope)).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            idempotencyKey: "classified-steer:user",
            __openclaw: expect.objectContaining({
              autoSteer: { choice: "steer", reason: "decision" },
            }),
          }),
        }),
      );

      fixture.decide.mockResolvedValue({ status: "choice", choice: "followup" });
      expectStarted(
        await fixture.send("classified-followup", "Then write the release notes.", {
          queueMode: "steer",
        }),
        "classified-followup",
      );
      await fixture.drain();
      expect(fixture.queueMessage).toHaveBeenCalledOnce();
      expect(fixture.dispatches).toHaveLength(2);
      expect(fixture.dispatches[1]?.replyOptions?.queueModeOverride).toBe("followup");
      expect(readHistory).toHaveBeenCalledTimes(2);
      expect(fixture.decide).toHaveBeenCalledTimes(2);
      expect(loadTranscriptEventsSync(fixture.scope)).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            idempotencyKey: "classified-followup:user",
            __openclaw: expect.objectContaining({
              autoSteer: { choice: "followup", reason: "decision" },
            }),
          }),
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["followup", "rejected-steer"] as const)(
    "retains source order across reverse decisions and %s custody, including an in-flight retry",
    async (firstRoute) => {
      const fixture = await createAutoFixture();
      const first = deferredDecision();
      const second = deferredDecision();
      const custody = createDeferred();
      try {
        fixture.decide.mockImplementation(async (event, context) => {
          const decision = event.newMessage === "First input" ? first : second;
          decision.entered.resolve(context);
          return await decision.result.promise;
        });
        if (firstRoute === "rejected-steer") {
          fixture.queueMessage.mockImplementationOnce(async (_text, _options, assertCurrent) => {
            assertCurrent();
            throw new Error("Runtime rejected before accepting custody");
          });
        }
        const fallbackEntered = createDeferred<Dispatch>();
        dispatchInboundMessageMock.mockImplementation(async (value: unknown) => {
          const dispatch = value as Dispatch;
          fixture.dispatches.push(dispatch);
          fallbackEntered.resolve(dispatch);
          await custody.promise;
          expect(dispatch.replyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
          await fixture.dispatchRelease.promise;
          dispatch.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
          return {};
        });
        const firstSend = fixture.send("first-input", "First input");
        await first.entered.promise;
        const retry = await fixture.send("first-input", "First input");
        expect(retry).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId: "first-input", status: "in_flight" }),
          undefined,
          expect.objectContaining({ cached: true }),
        );
        expect(fixture.decide).toHaveBeenCalledOnce();
        const secondSend = fixture.send("second-input", "Second input");
        await second.entered.promise;
        second.result.resolve({ status: "choice", choice: "steer" });
        // Drain ready continuations, never advance the 500ms optional deadline or poll.
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.queueMessage).not.toHaveBeenCalled();
        expect(fixture.dispatches).toEqual([]);
        expect(listSessionPendingInputs(fixture.scope).total).toBe(0);

        first.result.resolve({
          status: "choice",
          choice: firstRoute === "followup" ? "followup" : "steer",
        });
        expectStarted(await firstSend, "first-input");
        const fallback = await fallbackEntered.promise;
        expect(fallback.replyOptions).toMatchObject({
          queueModeOverride: firstRoute === "followup" ? "followup" : "steer",
          ...(firstRoute === "rejected-steer" ? { messageInjectionDisposition: "rejected" } : {}),
        });
        await vi.advanceTimersByTimeAsync(0);
        // ACK and rejection are not queue custody: input two must still be parked.
        expect(fixture.queueMessage).toHaveBeenCalledTimes(firstRoute === "followup" ? 0 : 1);
        expect(fixture.delivered).toEqual([]);
        expect(listSessionPendingInputs(fixture.scope).items.map((input) => input.runId)).toEqual([
          "first-input",
        ]);
        custody.resolve();
        expectStarted(await secondSend, "second-input");
        fixture.dispatchRelease.resolve();
        await fixture.drain();
        expect(fixture.delivered).toEqual(["Second input"]);
        expect(fixture.dispatches).toHaveLength(1);
        expect(fixture.decide).toHaveBeenCalledTimes(2);
        expect(readHistory).toHaveBeenCalledTimes(2);
        const replay = await fixture.send("second-input", "Second input");
        expect(replay.mock.calls[0]?.[0]).toBe(true);
        expect(replay.mock.calls[0]?.[3]).toMatchObject({ cached: true });
        expect(fixture.decide).toHaveBeenCalledTimes(2);
        expect(fixture.delivered).toEqual(["Second input"]);
      } finally {
        first.result.resolve({ status: "abstained" });
        second.result.resolve({ status: "abstained" });
        custody.resolve();
        await fixture.cleanup();
      }
    },
  );

  it.each(["steer", "followup", "oversized", "reply", "attachment"] as const)(
    "orders a later Auto-off %s send behind pending advice",
    async (kind) => {
      const fixture = await createAutoFixture();
      const queueMode = kind === "followup" ? "followup" : "steer";
      const message = kind === "oversized" ? "Long input ".repeat(801).trim() : "Second input";
      const first = deferredDecision();
      const secondReserved = createDeferred();
      const reserve = fixture.operation.reserveInputRouting.bind(fixture.operation);
      const reservations = vi.spyOn(fixture.operation, "reserveInputRouting");
      reservations.mockImplementation(() => {
        const result = reserve();
        if (reservations.mock.calls.length === 2) {
          secondReserved.resolve();
        }
        return result;
      });
      try {
        fixture.decide.mockImplementation(async (_event, context) => {
          first.entered.resolve(context);
          return await first.result.promise;
        });
        const firstSend = fixture.send("auto-first", "First input");
        await first.entered.promise;
        const overrides: Partial<typeof fixture.params> = { deliveryPolicy: undefined, queueMode };
        if (kind === "reply") {
          const target = fixture.activeTranscript
            .map(asOptionalRecord)
            .find((entry) => entry?.type === "message");
          if (typeof target?.id !== "string") {
            throw new Error("Missing reply target");
          }
          overrides.replyToId = target.id;
        }
        if (kind === "attachment") {
          overrides.attachments = [
            {
              type: "image",
              mimeType: "image/png",
              fileName: "dot.png",
              content:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
            },
          ];
        }
        const laterSend = fixture.send("manual-second", message, overrides);
        await Promise.race([
          secondReserved.promise,
          laterSend.then(() => {
            throw new Error("Later send completed without joining input ordering");
          }),
        ]);
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.queueMessage).not.toHaveBeenCalled();
        expect(fixture.dispatches).toEqual([]);
        expect(fixture.decide).toHaveBeenCalledOnce();
        first.result.resolve({ status: "choice", choice: "steer" });
        expectStarted(await firstSend, "auto-first");
        expectStarted(await laterSend, "manual-second");
        fixture.dispatchRelease.resolve();
        await fixture.drain();
        expect(fixture.delivered).toEqual(
          queueMode === "steer" && kind !== "attachment"
            ? ["First input", message]
            : ["First input"],
        );
        expect(fixture.dispatches).toHaveLength(
          queueMode === "followup" || kind === "attachment" ? 1 : 0,
        );
        expect(fixture.decide).toHaveBeenCalledOnce();
        // Reply context may use the history owner independently; only the
        // first Auto input may perform the bounded classifier evidence read.
        expect(
          readHistory.mock.calls.filter(
            ([scope]) =>
              asOptionalRecord(asOptionalRecord(scope)?.params)?.maxHistoryBytes === 32_000,
          ),
        ).toHaveLength(1);
      } finally {
        first.result.resolve({ status: "abstained" });
        await fixture.cleanup();
      }
    },
  );

  it("returns canonical abort receipts for an Auto-off input waiting behind classification", async () => {
    const fixture = await createAutoFixture();
    const decision = deferredDecision();
    const reserved = createDeferred();
    const reserve = fixture.operation.reserveInputRouting.bind(fixture.operation);
    const reservations = vi.spyOn(fixture.operation, "reserveInputRouting");
    reservations.mockImplementation(() => {
      const result = reserve();
      if (reservations.mock.calls.length === 2) {
        reserved.resolve();
      }
      return result;
    });
    try {
      fixture.decide.mockImplementation(async (_event, context) => {
        decision.entered.resolve(context);
        return await decision.result.promise;
      });
      const first = fixture.send("auto-before-stop", "First input");
      await decision.entered.promise;
      const manual = fixture.send("manual-before-stop", "Second input", {
        deliveryPolicy: undefined,
        queueMode: "steer",
      });
      await reserved.promise;
      fixture.operation.abortByUser();
      for (const response of await Promise.all([first, manual])) {
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          status: "timeout",
          summary: "aborted",
        });
      }
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      expect(fixture.dispatches).toEqual([]);
    } finally {
      decision.result.resolve({ status: "abstained" });
      await fixture.cleanup();
    }
  });

  it.each(["deadline", "labs", "caller"] as const)(
    "separates %s changes before runtime steering acceptance from input authority",
    async (change) => {
      const fixture = await createAutoFixture();
      const entered = createDeferred();
      const release = createDeferred();
      const original = fixture.queueMessage.getMockImplementation();
      if (!original) {
        throw new Error("Missing guarded sink");
      }
      try {
        fixture.queueMessage.mockImplementation(async (text, options, assertCurrent, kind) => {
          assertCurrent();
          entered.resolve();
          await release.promise;
          assertCurrent();
          return await original(text, options, assertCurrent, kind);
        });
        const send = fixture.send("waiting-acceptance", "Keep the input even if advice expires.");
        await entered.promise;
        if (change === "deadline") {
          fixture.clock.mockReturnValue(601);
        }
        if (change === "labs") {
          setDecisionAssistance(false);
        }
        if (change === "caller") {
          fixture.client.invalidated = true;
        }
        release.resolve();
        const response = await send;
        if (change === "caller") {
          expect(response.mock.calls[0]?.[0]).toBe(false);
          expect(fixture.dispatches).toEqual([]);
        } else {
          expectStarted(response, "waiting-acceptance");
          const fallback = await fixture.dispatchEntered.promise;
          expect(fallback.replyOptions?.queueModeOverride).toBe("followup");
        }
        fixture.dispatchRelease.resolve();
        await fixture.drain();
        expect(fixture.delivered).toEqual([]);
        expect(fixture.decide).toHaveBeenCalledOnce();
        expect(fixture.queueMessage).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await fixture.cleanup();
      }
    },
  );

  it("marks only a no-custody routing rejection so a fresh manual admission can bypass its cached failure", async () => {
    const fixture = await createAutoFixture();
    try {
      fixture.decide.mockRejectedValue(new Error("Adviser failed"));
      const failed = await fixture.send("failed-auto", "Keep the original input");
      expect(failed.mock.calls[0]?.[0]).toBe(false);
      expect(failed.mock.calls[0]?.[2]).toMatchObject({
        details: { code: "CHAT_INPUT_NOT_ACQUIRED" },
      });
      expect(listSessionPendingInputs(fixture.scope).total).toBe(0);
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      const replay = await fixture.send("failed-auto", "Keep the original input", {
        deliveryPolicy: undefined,
        queueMode: "steer",
      });
      expect(replay.mock.calls[0]?.[0]).toBe(false);
      expect(replay.mock.calls[0]?.[3]).toMatchObject({ cached: true });
      expectStarted(
        await fixture.send("manual-after-failure", "Keep the original input", {
          deliveryPolicy: undefined,
          queueMode: "steer",
        }),
        "manual-after-failure",
      );
      await fixture.drain();
      expect(fixture.decide).toHaveBeenCalledOnce();
      expect(fixture.delivered).toEqual(["Keep the original input"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains accepted steering custody beyond the advisory deadline until transcript settlement", async () => {
    const fixture = await createAutoFixture();
    const finish = createDeferred();
    const original = fixture.queueMessage.getMockImplementation();
    if (!original) {
      throw new Error("Missing real guarded fixture sink");
    }
    try {
      fixture.queueMessage.mockImplementation(async (text, options, assertCurrent, kind) => {
        assertCurrent();
        options?.onQueueAccepted?.(true);
        await finish.promise;
        assertCurrent();
        return await original(text, options, assertCurrent, kind);
      });
      expectStarted(
        await fixture.send("accepted-input", "Keep the exact parser behavior."),
        "accepted-input",
      );
      fixture.clock.mockReturnValue(1_000);
      finish.resolve();
      await fixture.drain();
      expect(fixture.delivered).toEqual(["Keep the exact parser behavior."]);
      expect(fixture.dispatches).toEqual([]);
    } finally {
      finish.resolve();
      await fixture.cleanup();
    }
  });
  it("does not rediscover a successor for an inherited steer fallback", async () => {
    const fixture = await createAutoFixture();
    const decision = deferredDecision();
    let successor: ReturnType<typeof createReplyOperation> | undefined;
    try {
      fixture.decide.mockImplementation(async (_event, context) => {
        decision.entered.resolve(context);
        return await decision.result.promise;
      });
      const pending = fixture.send("old-target-input", "Handle tabs too.", {
        queueMode: undefined,
      });
      await decision.entered.promise;
      fixture.operation.complete();
      successor = createReplyOperation({ ...fixture.scope, resetTriggered: false });
      const successorQueue = vi.fn();
      successor.setPhase("running");
      successor.attachBackend({
        kind: "embedded",
        runId: "successor-run",
        cancel: vi.fn(),
        messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage: successorQueue },
      });
      decision.result.resolve({ status: "choice", choice: "steer" });
      expectStarted(await pending, "old-target-input");
      const dispatch = await fixture.dispatchEntered.promise;
      expect(dispatch.replyOptions?.queueModeOverride).toBe("steer");
      expect(dispatch.replyOptions?.messageInjectionDisposition).toBe("rejected");
      expect(successorQueue).not.toHaveBeenCalled();
      fixture.dispatchRelease.resolve();
      await fixture.drain();
    } finally {
      decision.result.resolve({ status: "abstained" });
      successor?.complete();
      await fixture.cleanup();
    }
  });
  it("Stop cancels an admitted decision before ACK and a late choice cannot deliver or resurrect it", async () => {
    const fixture = await createAutoFixture();
    const decision = deferredDecision();
    try {
      fixture.decide.mockImplementation(async (_event, context) => {
        decision.entered.resolve(context);
        return await decision.result.promise;
      });
      const send = fixture.send("stopped-input", "Update the current work.");
      const context = await decision.entered.promise;
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "stop",
          method: "chat.abort",
          params: { sessionKey: fixture.scope.sessionKey, runId: "stopped-input" },
        },
        client: fixture.client,
        context: fixture.context,
        respond,
        isWebchatConnect: () => true,
      });
      expect(respond.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
      expect(context.signal.aborted).toBe(true);
      const response = await send;
      expect(
        response.mock.calls.some(
          ([, payload]) =>
            typeof payload === "object" &&
            payload !== null &&
            "status" in payload &&
            payload.status === "started",
        ),
      ).toBe(false);
      decision.result.resolve({ status: "choice", choice: "steer" });
      await vi.advanceTimersByTimeAsync(0);
      await fixture.drain();
      expect(fixture.queueMessage).not.toHaveBeenCalled();
      expect(fixture.dispatches).toEqual([]);
      expect(listSessionPendingInputs(fixture.scope).total).toBe(0);
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(() => context.assertCurrent()).toThrow();
      const replay = await fixture.send("stopped-input", "Update the current work.");
      expect(replay.mock.calls[0]?.[3]).toMatchObject({ cached: true });
      expect(fixture.decide).toHaveBeenCalledOnce();
      expect(fixture.queueMessage).not.toHaveBeenCalled();
    } finally {
      decision.result.resolve({ status: "abstained" });
      await fixture.cleanup();
    }
  });
});
