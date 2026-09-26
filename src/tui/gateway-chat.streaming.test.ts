import { describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { ChatLog } from "./components/chat-log.js";
import { withGatewayChatConnection } from "./gateway-chat.test-support.js";
import type { TuiEvent } from "./tui-backend.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { makeTuiState } from "./tui-event-test-support.js";
import { createTestSessionActions, makeTui } from "./tui-session-actions-test-support.js";
import type { ChatEvent, TuiHistoryLoadResult } from "./tui-types.js";

describe("GatewayChatClient streaming", () => {
  it("continues a background stream after session selection and a lagging history response", async () => {
    const selectedKey = "agent:main:b";
    const history = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method !== "chat.history") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return history.promise;
    });
    await withGatewayChatConnection(request, async (client, callbacks) => {
      const state = makeTuiState({ currentSessionKey: "agent:main:a", currentSessionId: "a" });
      const chatLog = new ChatLog();
      const tui = makeTui();
      const btw = { clear: vi.fn(), showResult: vi.fn() };
      const setActivityStatus = (activity: string) => {
        state.activityStatus = activity;
      };
      let loadHistory: () => Promise<TuiHistoryLoadResult> = async () => ({ loaded: false });
      const handlers = createEventHandlers({
        state,
        chatLog,
        btw,
        tui,
        setActivityStatus,
        updateFooter: vi.fn(),
        loadHistory: () => loadHistory(),
        streamingWatchdogMs: 0,
      });
      const actions = createTestSessionActions({
        client,
        state,
        chatLog,
        btw,
        tui,
        setActivityStatus,
        invalidateRunOwnership: handlers.dispose,
      });
      loadHistory = actions.loadHistory;
      client.onEvent = (event) => {
        if (event.event === "chat") {
          handlers.handleChatEvent(event.payload);
        }
      };
      const emit = (payload: ChatEvent) =>
        callbacks.onEvent?.({ type: "event", event: "chat", payload });
      const delta = { sessionKey: selectedKey, runId: "run-b", state: "delta" as const };
      const render = () => normalizeTestText(chatLog.render(120).join("\n"));
      try {
        emit({
          ...delta,
          seq: 1,
          deltaText: "Hello",
          message: { role: "assistant", content: "Hello" },
        });
        expect(render()).not.toContain("Hello");

        const selecting = actions.setSession(selectedKey);
        expect(request).toHaveBeenCalledWith("chat.history", {
          sessionKey: selectedKey,
          limit: 200,
        });
        emit({ ...delta, seq: 2, deltaText: " world" });
        history.resolve({
          messages: [],
          sessionInfo: { key: selectedKey, sessionId: "b", activeRunIds: ["run-b"] },
          inFlightRun: { runId: "run-b", text: "Hello" },
        });
        await selecting;
        expect(state.activeChatRunId).toBe("run-b");
        expect(render()).toContain("Hello");
        emit({ ...delta, seq: 3, deltaText: "!" });
        expect(render()).toContain("Hello world!");

        emit({ ...delta, seq: 4, deltaText: "", replace: true });
        expect(render()).not.toContain("Hello");
        emit({ ...delta, seq: 5, deltaText: "Rewritten" });
        expect(render()).toContain("Rewritten");
      } finally {
        handlers.dispose();
        chatLog.dispose();
      }
    });
  });

  it.each(["final", "error", "aborted", "disconnect", "stop"] as const)(
    "retires wire baselines on %s",
    async (boundary) => {
      await withGatewayChatConnection(
        async () => ({}),
        async (client, callbacks) => {
          const received: TuiEvent[] = [];
          client.onEvent = (event) => received.push(event);
          const delta = { sessionKey: "agent:main:b", runId: "run-b", state: "delta" };
          const emit = (payload: unknown) =>
            callbacks.onEvent?.({ type: "event", event: "chat", payload });
          emit({ ...delta, message: { role: "assistant", content: "Retired" } });
          if (boundary === "disconnect") {
            callbacks.onClose?.(1006, "reconnecting");
          } else if (boundary === "stop") {
            await client.stop();
          } else {
            emit({ ...delta, state: boundary });
          }
          emit({ ...delta, deltaText: " suffix" });
          expect(received.at(-1)?.payload).toEqual({
            ...delta,
            deltaText: " suffix",
            message: undefined,
          });
        },
      );
    },
  );
});
