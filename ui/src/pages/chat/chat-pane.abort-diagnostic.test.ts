/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-abort.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import * as chatSendSupport from "./chat-send-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

function createDiagnosticPane() {
  const client = createGatewayBrowserClientFixture({
    request: (method) => {
      if (method === "chat.history" || method === "chat.startup") {
        return { messages: [] };
      }
      if (method === "taskSuggestions.list" || method === "session.suggestions.list") {
        return { suggestions: [] };
      }
      return {};
    },
  });
  const { pane, state } = createTestChatPane({
    client,
    sessions: createSessionCapabilityFixture({
      state: { result: null, agentId: "main", modelOverrides: {} },
    }),
  });
  state.settings = loadSettings();
  state.chatSubmissions = pane.context.chatSubmissions;
  state.chatRunError = null;
  state.loadAssistantIdentity = vi.fn(async () => undefined);
  pane.context.agents.ensureList = vi.fn(async () => null);
  pane.sessionKey = state.sessionKey;
  const run = { sessionKey: state.sessionKey, runId: "interrupted-run" };
  handleChatGatewayEvent(state, { ...run, state: "delta", deltaText: "" });
  handleChatGatewayEvent(state, { ...run, state: "aborted", seq: 30 });
  expect(state.chatRunId).toBeNull();
  expect(state.chatRunError).toBeNull();
  return { pane, state, client, run };
}

describe("chat pane late diagnostics across Gateway connections", () => {
  afterEach(() => vi.restoreAllMocks());

  it("displays the active run's terminal error after its history advances the leaf", async () => {
    const sessionKey = "agent:main:current";
    const sessionId = "live-history-session";
    const runId = "live-history-run";
    let history: ChatHistoryResult = {
      sessionId,
      messages: [],
      sessionInfo: {
        key: sessionKey,
        kind: "direct",
        updatedAt: 1,
        sessionId,
        hasActiveRun: false,
        activeRunIds: [],
        activeLeafEntryId: null,
      },
    };
    const client = createGatewayBrowserClientFixture({
      request: (method) => (method === "chat.history" ? history : {}),
    });
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture(),
    });
    state.settings = loadSettings();
    state.chatRunError = null;
    state.chatSubmissions = pane.context.chatSubmissions;
    await loadChatHistory(state, { deferBranches: true });
    expect(state.chatDisplayedLeafEntryId).toBeNull();
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: { sessionKey, runId, state: "delta", deltaText: "" },
    });
    const userMessage = {
      role: "user",
      content: "List all automations.",
      __openclaw: { id: "user-leaf", seq: 1, idempotencyKey: `${runId}:user` },
    };
    const toolMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "list-call", name: "automations", arguments: { action: "list" } },
      ],
      __openclaw: { id: "tool-leaf", seq: 2, runId },
    };
    for (const snapshot of [
      { leaf: "user-leaf", messages: [userMessage] },
      { leaf: "tool-leaf", messages: [userMessage, toolMessage] },
    ]) {
      history = {
        sessionId,
        messages: snapshot.messages,
        sessionInfo: {
          key: sessionKey,
          kind: "direct",
          updatedAt: 2,
          sessionId,
          status: "running",
          hasActiveRun: true,
          activeLeafEntryId: snapshot.leaf,
        },
        inFlightRun: { runId, text: "", startedAt: 1 },
      };
      await loadChatHistory(state, { deferBranches: true });
      expect(state.chatDisplayedLeafEntryId).toBe(snapshot.leaf);
      expect(state.chatRunId).toBe(runId);
    }

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: { sessionKey, runId, state: "aborted", seq: 30 },
    });
    expect(state.chatRunId).toBeNull();
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey,
        runId,
        state: "error",
        seq: 1,
        errorMessage: "Automations listed.\nCount: 2\nRestricted automation inventory.",
      },
    });

    expect(state.chatRunError).toEqual({
      runId,
      summary: "Error: Automations listed.\nCount: 2\nRestricted automation inventory.",
    });
    expect(state.chatMessages).toContainEqual(userMessage);
    expect(state.chatRunId).toBeNull();
  });

  it("does not give a replacement client the previous run's diagnostic", async () => {
    const { pane, state, run } = createDiagnosticPane();
    const replacement = createGatewayBrowserClientFixture({
      request: () => ({ messages: [], suggestions: [] }),
    });

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: replacement,
      phase: "connected",
    });
    await vi.dynamicImportSettled();
    handleChatGatewayEvent(state, {
      ...run,
      state: "error",
      seq: 1,
      errorMessage: "Previous connection diagnostic",
    });

    expect(state.client).toBe(replacement);
    expect(state.chatRunError).toBeNull();
    expect(state.chatRunId).toBeNull();
  });

  it("recovers the same run's late diagnostic after the same client reconnects", async () => {
    const { pane, state, client, run } = createDiagnosticPane();
    const snapshot = pane.context.gateway.snapshot;

    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
    await vi.dynamicImportSettled();
    handleChatGatewayEvent(state, {
      ...run,
      state: "error",
      seq: 1,
      errorMessage: "Automations listed.\nCount: 2\nRestricted automation inventory.",
    });

    expect(state.client).toBe(client);
    expect(state.chatRunError).toEqual({
      runId: run.runId,
      summary: "Error: Automations listed.\nCount: 2\nRestricted automation inventory.",
    });
    expect(state.chatRunId).toBeNull();
  });

  it("rejects a terminal whose pending input retirement finishes after reconnect", async () => {
    const { pane, state, run } = createDiagnosticPane();
    const retirement = createDeferred<"retired">();
    vi.spyOn(chatSendSupport, "retireDeliveredQueuedUserTurn").mockReturnValueOnce(
      retirement.promise,
    );
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        ...run,
        state: "error",
        seq: 1,
        errorMessage: "Delayed previous connection diagnostic",
      },
    });
    const snapshot = pane.context.gateway.snapshot;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
    await vi.dynamicImportSettled();

    retirement.resolve("retired");
    await retirement.promise;

    expect(state.chatRunError).toBeNull();
    expect(state.chatRunId).toBeNull();
  });

  it.each([
    { publication: "same-key reset", displays: false },
    { publication: "accepted branch replacement", displays: false },
    { publication: "same-scope snapshot", displays: true },
  ])(
    "applies a deferred first terminal only to its retained scope after $publication",
    async ({ publication, displays }) => {
      const { state } = createDiagnosticPane();
      state.currentSessionId = "session-before";
      state.chatDisplayedLeafEntryId = "leaf-before";
      reduceChatSessionProjection(state, { type: "snapshotLoaded", messages: [] });
      const sessionKey = state.sessionKey;
      const connectionEpoch = state.connectionEpoch;
      const retirement = createDeferred<"retired">();
      vi.spyOn(chatSendSupport, "retireDeliveredQueuedUserTurn").mockReturnValueOnce(
        retirement.promise,
      );
      // No earlier run event identifies this terminal; retained-run history alone cannot fence it.
      const runId = "pending-first-terminal";
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey,
          runId,
          state: "error",
          errorMessage: "Deferred terminal diagnostic",
        },
      });
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "Current transcript" }] },
      ];
      if (publication === "same-key reset") {
        resetChatHistoryProjection(state);
      } else {
        if (publication === "accepted branch replacement") {
          state.chatDisplayedLeafEntryId = "leaf-after";
        }
        reduceChatSessionProjection(state, { type: "snapshotLoaded", messages });
      }

      retirement.resolve("retired");
      await retirement.promise;

      expect(state.sessionKey).toBe(sessionKey);
      expect(state.connectionEpoch).toBe(connectionEpoch);
      expect(state.chatRunError).toEqual(
        displays ? { runId, summary: "Error: Deferred terminal diagnostic" } : null,
      );
      expect(state.chatRunId).toBeNull();
      expect(state.chatMessages).toEqual(publication === "same-key reset" ? [] : messages);
    },
  );
});
