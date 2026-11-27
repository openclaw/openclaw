import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../infra/embedded-mode.js";
import {
  getEmbeddedQuestionBroker,
  EmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "../../infra/embedded-question-broker.js";
import type { AcpRuntimeEvent } from "../../plugin-sdk/acp-runtime.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { completeAcpSessionFixture } from "./dispatch-from-config.acp-fixture.test-support.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  createDispatcher,
  hookMocks,
  internalHookMocks,
  mocks,
  mockSessionStorePath,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createAcpRuntime, createDispatchGate } from "./dispatch-from-config.test-support.js";
import { prepareReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let controllerTesting: typeof import("../../sessions/session-controller.test-support.js").testing;
// Loaded after the harness mocks so the real manager reads the mocked ACP metadata.
let AcpSessionManager: typeof import("../../acp/control-plane/manager.core.js").AcpSessionManager;
let acpManagerDeps: typeof import("../../acp/control-plane/manager.types.js").DEFAULT_DEPS;

const acpKey = "agent:codex:acp:controller-turns";
const hooks = hookMocks.runner;
const store = sessionStoreMocks;
const cfg = {
  acp: { enabled: true, dispatch: { enabled: true } },
  session: { sendPolicy: { default: "allow" } },
} as OpenClawConfig;

function createGatedRuntime() {
  const started: string[] = [];
  const turns = new Map<string, ReturnType<typeof createDispatchGate<void>>>();
  const gate = (text: string) => {
    const turn = turns.get(text) ?? createDispatchGate();
    turns.set(text, turn);
    return turn;
  };
  const runtime = createAcpRuntime([]);
  runtime.runTurn.mockImplementation(async function* (input) {
    started.push(input.text);
    await gate(input.text).wait();
    yield { type: "done" } as AcpRuntimeEvent;
  });
  return {
    runtime,
    started,
    entered: (text: string, work: Promise<unknown>) =>
      awaitGateBeforeSettlement(
        gate(text).started,
        work,
        `ACP work settled before runtime entry: ${text}`,
      ),
    release: (text: string) => gate(text).resolve(),
  };
}

function mockAcpSession(sessionKey: string) {
  const entry = { sessionId: "acp-session-id", updatedAt: Date.now() };
  sessionStoreMocks.entriesBySessionKey.set(sessionKey, entry);
  acpMocks.readAcpSessionEntry.mockImplementation((params: { sessionKey: string }) =>
    params.sessionKey === sessionKey
      ? completeAcpSessionFixture(
          { entry, acp: { agent: "codex" } },
          { sessionKey, storePath: mockSessionStorePath },
        )
      : null,
  );
}

async function dispatchTo(
  sessionKey: string,
  body: string,
  onSourceReserved?: (input: SessionControllerInput) => void,
) {
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    AccountId: "default",
    To: "C1",
    SessionKey: sessionKey,
    BodyForAgent: body,
  });
  const source = await prepareReplySourceInput(ctx, cfg, {});
  if (source.input) {
    onSourceReserved?.(source.input);
  }
  return dispatchReplyFromConfig({
    ctx,
    cfg,
    dispatcher: createDispatcher(),
    replyOptions: source.options,
  });
}

describe("dispatchReplyFromConfig ACP controller turns", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    ({ testing: controllerTesting } =
      await import("../../sessions/session-controller.test-support.js"));
    ({ AcpSessionManager } = await import("../../acp/control-plane/manager.core.js"));
    ({ DEFAULT_DEPS: acpManagerDeps } = await import("../../acp/control-plane/manager.types.js"));
  });

  let replyDispatchEntries: string[];
  let manager: InstanceType<typeof AcpSessionManager>;

  beforeEach(() => {
    setDiscordTestRegistry();
    controllerTesting.resetSessionControllerForTest();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
    for (const mock of [...Object.values(hooks), ...Object.values(acpMocks)]) {
      mock.mockReset();
    }
    manager = new AcpSessionManager({
      ...acpManagerDeps,
      prepareSessionControlRead: async (params) => {
        const readCurrent = async () => {
          params.assertCurrent?.();
          const session = completeAcpSessionFixture(acpMocks.readAcpSessionEntry(params), {
            ...params,
            storePath: sessionStoreMocks.resolveSessionStorePathCore(),
          });
          if (!session) {
            throw new Error(`Expected ACP session fixture: ${params.sessionKey}`);
          }
          return { session, entry: session.entry };
        };
        return {
          initialRead: await readCurrent(),
          readCurrent,
          assertCurrent: () => params.assertCurrent?.(),
          release: () => {},
        };
      },
    });
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(manager);
    replyDispatchEntries = [];
    hooks.hasHooks.mockReset().mockImplementation((name?: string) => name === "reply_dispatch");
    hooks.runReplyDispatch.mockReset().mockImplementation(async (event: unknown, ctx: unknown) => {
      replyDispatchEntries.push(String((event as { sessionKey?: string }).sessionKey));
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    internalHookMocks.createInternalHookEvent
      .mockReset()
      .mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    store.currentEntry = undefined;
    store.entriesBySessionKey.clear();
    const readSessionEntry = (scope: unknown) => {
      if (
        !scope ||
        typeof scope !== "object" ||
        !("sessionKey" in scope) ||
        typeof scope.sessionKey !== "string"
      ) {
        throw new Error("Expected session lookup scope");
      }
      return store.entriesBySessionKey.get(scope.sessionKey);
    };
    for (const load of [store.loadSessionEntry, store.loadSessionStoreEntry]) {
      load.mockReset().mockImplementation(readSessionEntry);
    }
    store.resolveSessionStorePathCore.mockReset().mockReturnValue(mockSessionStorePath);
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
  });

  it("settles a bound channel answer before the asking ACP turn completes", async () => {
    const { dispatchInboundMessageWithRoutedChannelDispatcher } = await import("../dispatch.js");
    mockAcpSession(acpKey);
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-controller",
      targetSessionKey: acpKey,
      targetKind: "session",
      status: "active",
      boundAt: Date.now(),
      conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
    });
    const promptDelivered = createDeferred();
    const response = createDeferred<unknown>();
    const release = createDeferred();
    const cancel = new AbortController();
    const runtime = createAcpRuntime([]);
    const started: string[] = [];
    runtime.runTurn.mockImplementation(async function* (input) {
      started.push(input.text);
      if (input.text === "ask") {
        if (!input.onElicitation) throw new Error("missing ACP elicitation handler");
        response.resolve(
          await input.onElicitation(
            {
              mode: "form",
              sessionId: "acp-session",
              toolCallId: "color",
              message: "Choose a color",
              requestedSchema: {
                type: "object",
                properties: {
                  color: { type: "string", enum: ["Red", "Blue"] },
                },
                required: ["color"],
              },
            },
            { requestId: "color", signal: cancel.signal },
          ),
        );
        await release.promise;
      }
      yield { type: "done" };
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
    const answerSettled = vi.fn();
    const send = async (body: string) => {
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        AccountId: "default",
        From: "C1",
        To: "C1",
        SenderId: "U1",
        SessionKey: "agent:main:discord:channel:C1",
        Body: body,
        RawBody: body,
        CommandBody: body,
        BodyForAgent: body,
        MessageSid: `m-${body}`,
      });
      const source = await prepareReplySourceInput(ctx, cfg, {});
      return dispatchInboundMessageWithRoutedChannelDispatcher({
        ctx,
        cfg,
        replyOptions: source.options,
        dispatcherOptions: {
          deliver: async (payload) => {
            if (payload.text?.includes("Red")) promptDelivered.resolve();
          },
          onSettled: body === "1" ? answerSettled : undefined,
        },
      });
    };
    const previousBroker = getEmbeddedQuestionBroker();
    const wasEmbedded = isEmbeddedMode();
    const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
    setEmbeddedMode(true);
    setEmbeddedQuestionBroker(broker);
    const first = send("ask");
    let answer: Promise<unknown> | undefined;
    try {
      await withTestTimeout(promptDelivered.promise, 10000, "bound question was not delivered");
      answer = send("1");
      expect(
        await withTestTimeout(response.promise, 3000, "answer waited for the asking turn"),
      ).toEqual({
        action: "accept",
        content: { color: "Red" },
      });
      await withTestTimeout(answer, 3000, "answer source did not settle");
      expect(answerSettled).toHaveBeenCalledOnce();
      release.resolve();
      await withTestTimeout(first, 3000, "asking turn did not finish");
      // A later ordinary turn crosses the same FIFO after any queued duplicate.
      await withTestTimeout(send("next"), 3000, "next bound turn did not settle");
      expect(started).toEqual(["ask", "next"]);
    } finally {
      cancel.abort();
      release.resolve();
      try {
        await withTestTimeout(
          Promise.allSettled([first, answer]),
          3000,
          "ACP dispatch did not drain",
        );
      } finally {
        broker.stop();
        setEmbeddedQuestionBroker(previousBroker);
        setEmbeddedMode(wasEmbedded);
      }
    }
  });

  it.each(["tool result", "thought", "noise"] as const)(
    "tracks ACP reply progress when the backend emits %s",
    async (activity) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      const observed = createDispatchGate();
      const runtime = createAcpRuntime([]);
      const completed: AcpRuntimeEvent = {
        type: "tool_call",
        toolCallId: "tool-1",
        status: "completed",
        text: "fixture result",
      };
      runtime.runTurn.mockImplementation(async function* () {
        vi.setSystemTime(start + 60_000);
        yield completed;
        vi.setSystemTime(start + 300_000);
        if (activity === "tool result") {
          yield { ...completed, toolCallId: "tool-2" };
        } else if (activity === "thought") {
          yield { type: "text_delta", text: "Working in ACP", stream: "thought" };
        } else {
          yield completed;
          yield { ...completed, toolCallId: "tool-2", status: "in_progress" };
          yield { type: "text_delta", text: " " };
          yield { type: "status", text: "usage update", tag: "usage_update" };
        }
        await observed.wait();
        yield { type: "done" };
      });
      mockAcpSession(acpKey);
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
      let source: SessionControllerInput | undefined;
      const turn = dispatchTo(acpKey, activity, (input) => {
        source = input;
      });
      try {
        await awaitGateBeforeSettlement(observed.started, turn, "ACP output was not consumed");
        const watchdog = source?.claim?.operation?.watchdog;
        expect(watchdog?.snapshot().semanticProgressAtMs).toBe(
          start + (activity === "noise" ? 60_000 : 300_000),
        );
        vi.setSystemTime(start + 435_000);
        expect(watchdog?.decide().action).toBe(activity === "noise" ? "stop" : "observe");
        observed.resolve();
        await turn;
      } finally {
        observed.resolve();
        await Promise.allSettled([turn]);
        vi.useRealTimers();
      }
    },
  );

  it.each(["agent", "bound"] as const)(
    "serializes channel dispatch behind a %s ACP turn",
    async (first) => {
      mockAcpSession(acpKey);
      const gated = createGatedRuntime();
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime: gated.runtime });
      if (first === "bound") {
        sessionBindingMocks.resolveByConversation.mockReturnValue({
          bindingId: "binding-controller",
          targetSessionKey: acpKey,
          targetKind: "session",
          status: "active",
          boundAt: Date.now(),
          conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
        });
      }
      const firstTurn =
        first === "bound"
          ? dispatchTo("agent:main:discord:channel:C1", first)
          : manager.runTurn({
              admittedRunContext: createTestAdmittedRunContext("agent-run"),
              cfg,
              sessionKey: acpKey,
              provenance: "system",
              text: "agent",
              mode: "prompt",
              requestId: "agent-run",
            });
      const second = first === "agent" ? "prompt" : "direct";
      let pending: ReturnType<typeof dispatchTo> | undefined;
      try {
        await gated.entered(first, firstTurn);
        sessionBindingMocks.resolveByConversation.mockReturnValue(null);
        let input: SessionControllerInput | undefined;
        pending = dispatchTo(acpKey, second, (reserved) => {
          input = reserved;
        });
        if (first === "agent") {
          await vi.waitFor(() => expect(input?.phase).toBe("waiting"), { timeout: 10_000 });
        } else {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        expect(replyDispatchEntries).toEqual(first === "agent" ? [] : [acpKey]);
        gated.release(first);
        await firstTurn;
        await gated.entered(second, pending);
        gated.release(second);
        await pending;
        expect(gated.started).toEqual([first, second]);
      } finally {
        gated.release(first);
        gated.release(second);
        await Promise.allSettled([firstTurn, pending]);
      }
    },
  );
});
