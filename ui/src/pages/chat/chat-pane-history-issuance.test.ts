/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import * as toast from "../../lib/toast.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { requestCalls } from "./chat-host.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createTestChatPane, createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import { renderChatComposerNotices } from "./chat-view-notices.ts";
import * as performanceEvents from "./performance.ts";

it.each(["failed", "healthy", "read-error", "scope-changed"] as const)(
  "reports a scoped manual Refresh outcome for %s without retrying work",
  async (outcome) => {
    const history = createDeferred<Record<string, unknown>>();
    const request = vi.fn((method: string) =>
      method === "chat.history" ? history.promise : Promise.resolve({}),
    );
    const client = createGatewayBrowserClientFixture({ request });
    const { pane, state } = createRefreshChatPane(client);
    const key = "agent:main:dashboard:refresh-worker";
    state.sessionKey = key;
    state.chatRunError = {
      runId: "prior-failed-run",
      summary: "Runner failed: Ephemeral worker lost; recover from recorded repository branch",
    };
    state.chatQueue = [
      {
        id: "held-input",
        text: "Unsubmitted follow-up",
        createdAt: 1,
        sendState: "waiting-idle",
        sendAttempts: 0,
      },
    ];
    state.eventLogBuffer = [];
    const feedback = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const container = document.body.appendChild(document.createElement("div"));
    const completion = createDeferred();
    const recordEvent = performanceEvents.recordControlUiPerformanceEvent;
    const eventObserver = vi
      .spyOn(performanceEvents, "recordControlUiPerformanceEvent")
      .mockImplementation((...args) => {
        recordEvent(...args);
        if (args[1] === "chat.refresh" && args[2].stage === "result") {
          completion.resolve();
        }
      });
    const update = () => {
      pane.render();
      render(renderChatComposerNotices(pane.chatProps!), container);
    };
    state.requestUpdate = update;
    try {
      update();
      container.querySelector<HTMLButtonElement>(".chat-error__refresh")!.click();
      expect(requestCalls(request, "chat.history")).toHaveLength(1);
      expect(container.querySelector(".chat-error__refresh")?.getAttribute("aria-busy")).toBe(
        "true",
      );
      expect(container.querySelector(".chat-error__refresh")?.textContent).toContain("Refreshing…");
      if (outcome === "scope-changed") {
        state.sessionKey = "agent:main:different";
      }
      if (outcome === "read-error") {
        history.reject(
          new GatewayRequestError({ code: "UNAVAILABLE", message: "Synthetic read failure" }),
        );
      } else {
        history.resolve({
          messages: [],
          sessionInfo: {
            key,
            sessionId: "refresh-worker-session",
            kind: "direct",
            updatedAt: 1,
            placement: {
              state: outcome === "healthy" ? "active" : "failed",
              generation: 19,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
              recoveryError: "Ephemeral worker lost; recover from recorded repository branch",
            },
          },
        });
      }
      await history.promise.catch(() => {});
      await completion.promise;
      if (outcome === "scope-changed") {
        expect(
          state.eventLogBuffer?.some(
            (entry) =>
              isRecord(entry) && isRecord(entry.payload) && entry.payload.stage === "result",
          ),
        ).toBe(true);
        expect(feedback).not.toHaveBeenCalled();
      } else {
        expect(feedback).toHaveBeenCalledWith({
          message:
            outcome === "failed"
              ? "Conversation refreshed. The runner is still unavailable."
              : outcome === "healthy"
                ? "Conversation refreshed."
                : "Could not refresh this conversation. Previous state kept.",
        });
      }
      expect(state.chatQueue.map((item) => item.id)).toEqual(["held-input"]);
      for (const method of [
        "chat.send",
        "sessions.recover",
        "sessions.dispatch",
        "sessions.reclaim",
        "sessions.create",
      ]) {
        expect(requestCalls(request, method)).toHaveLength(0);
      }
    } finally {
      state.connected = false;
      history.resolve({ messages: [] });
      feedback.mockRestore();
      eventObserver.mockRestore();
      container.remove();
    }
  },
);

function createCanonicalRoutePane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
  vi.spyOn(sessions, "listBranches").mockResolvedValue([]);
  onTestFinished(() => sessions.dispose());
  const { pane, state } = createTestChatPane({ client, sessions });
  const hello = {
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "agent:main:main",
      },
    },
  } as unknown as NonNullable<ApplicationContext["gateway"]["snapshot"]["hello"]>;
  state.hello = hello;
  state.settings = {
    sessionKey: state.sessionKey,
    lastActiveSessionKey: state.sessionKey,
  } as typeof state.settings;
  pane.sessionKey = "main";
  pane.connectedClient = null;
  pane.active = true;
  pane.presented = true;
  const snapshot = {
    ...pane.context.gateway.snapshot,
    assistantAgentId: "main",
    client,
    hello,
    phase: "connected" as const,
  };
  return { pane, state, snapshot };
}

function assistantHistory(text: string) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  };
}

describe("chat pane history issuance across Gateway connection transitions", () => {
  it("does not request the optional header platform while initial history is pending", async () => {
    const subscribed = createDeferred();
    const historyStarted = createDeferred();
    const history = createDeferred<ReturnType<typeof assistantHistory>>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.messages.subscribe") {
        return subscribed.promise.then(() => ({}));
      }
      if (method === "chat.startup") {
        historyStarted.resolve();
        return history.promise;
      }
      return Promise.resolve({});
    });
    const { pane, state, snapshot } = createCanonicalRoutePane(request);
    pane.sessionKey = state.sessionKey;
    state.loadAssistantIdentity = vi.fn(async () => undefined);
    const hello = { ...snapshot.hello, features: { methods: ["system.info"], events: [] } };
    pane.context.gateway.snapshot.hello = hello;
    try {
      pane.applyGatewaySnapshot({ ...snapshot, hello });
      expect(requestCalls(request, "chat.startup")).toHaveLength(0);
      subscribed.resolve();
      await historyStarted.promise;
      expect(requestCalls(request, "chat.startup")).toHaveLength(1);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toEqual([]);
    } finally {
      history.resolve(assistantHistory("Selected transcript"));
      await history.promise;
    }
  });

  it("issues a disconnected history request once when connection redirects the route", async () => {
    const request = vi.fn().mockResolvedValue(assistantHistory("Recovered transcript"));
    const { pane, state, snapshot } = createCanonicalRoutePane(request);
    state.connected = false;

    await loadChatHistory(state);

    expect(request).not.toHaveBeenCalled();
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "pending-connection",
      sessionKey: "agent:main:current",
      startup: false,
    });
    expect(state.chatLoading).toBe(true);

    pane.applyGatewaySnapshot(snapshot);

    await vi.waitFor(() => expect(requestCalls(request, "chat.history")).toHaveLength(1));
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      {
        sessionKey: "agent:main:current",
        limit: 80,
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    await vi.waitFor(() =>
      expect(state.chatMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Recovered transcript" }] },
      ]),
    );
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
  });

  it("automatically retries a retryable history failure when the Gateway reconnects", async () => {
    let historyAttempts = 0;
    const request = vi.fn((method: string) => {
      if (method !== "chat.startup") {
        return Promise.resolve({});
      }
      historyAttempts += 1;
      return historyAttempts === 1
        ? Promise.reject(
            new GatewayRequestError({
              code: "GATEWAY_UNAVAILABLE",
              message: "Gateway connection interrupted",
              retryable: true,
            }),
          )
        : Promise.resolve(assistantHistory("Recovered after reconnect"));
    });
    const { pane, state, snapshot } = createCanonicalRoutePane(request);

    await loadChatHistory(state, { startup: true });

    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "failed",
      sessionKey: state.sessionKey,
      retryable: true,
      startup: true,
    });
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    pane.applyGatewaySnapshot(snapshot);

    await vi.waitFor(() => expect(requestCalls(request, "chat.startup")).toHaveLength(2));
    expect(request).toHaveBeenCalledWith(
      "chat.startup",
      {
        sessionKey: state.sessionKey,
        limit: 80,
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    await vi.waitFor(() =>
      expect(state.chatMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Recovered after reconnect" }] },
      ]),
    );
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
  });

  it("discards a disconnected history request after the selected session changes", async () => {
    const request = vi.fn();
    const { pane, state, snapshot } = createCanonicalRoutePane(request);
    state.connected = false;

    await loadChatHistory(state);

    expect(getChatHistoryLoadState(state).phase).toBe("pending-connection");
    state.sessionKey = "agent:main:different-session";
    pane.applyGatewaySnapshot(snapshot);

    expect(requestCalls(request, "chat.history")).toHaveLength(0);
    expect(requestCalls(request, "chat.startup")).toHaveLength(0);
    expect(getChatHistoryLoadState(state)).toEqual({ phase: "idle" });
    expect(state.chatLoading).toBe(false);
  });
});
