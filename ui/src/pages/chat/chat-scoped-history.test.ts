/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult as sessionListFixture,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

const requireRecord = createRequireRecord("object", "expected-label");
function sessionRow(name: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: "global",
    kind: "global",
    updatedAt: 10,
    modelProvider: "test",
    hasActiveRun: false,
    status: "done",
    sessionId: `${name === "main" ? "main" : "work"}-incarnation`,
    label: name,
    model: `model-${name}`,
    ...extra,
  };
}

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestIdleCallback", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["same-owner equal timestamp control", false, "updated"],
  ["different-owner equal timestamp regression", true, "updated"],
  ["missing Work row remains admissible", true, "missing"],
  ["Main-only publication does not freeze Work history", true, "none"],
] as const)("%s", async (_name, moveRoster, workRefresh) => {
  const pendingHistory = createDeferred<ChatHistoryResult>();
  const initialWork = sessionRow("old", { contextTokens: 1000, totalTokens: 10 });
  const newerWork = sessionRow("new", { contextTokens: 2000, totalTokens: 10 });
  const mainRow = sessionRow("main");
  let workListCount = 0;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "chat.history") {
      expect(params).toMatchObject({ sessionKey: "agent:work:main", agentId: "work" });
      return pendingHistory.promise;
    }
    const agentId =
      method === "sessions.list" && requireRecord(params, "session list params").agentId;
    if (agentId === "work") {
      return sessionListFixture(
        ++workListCount === 1 ? [initialWork] : workRefresh === "missing" ? [] : [newerWork],
        workListCount,
      );
    }
    if (agentId === "main") {
      return sessionListFixture([mainRow], 3);
    }
    throw new Error(`Unexpected RPC ${method}: ${JSON.stringify(params)}`);
  });
  const client = createTestGatewayClient(request);
  const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
  const { pane, state } = createTestChatPane({ client, sessions });
  state.sessionKey = "agent:work:main";
  state.assistantAgentId = "work";
  state.agentsList = makeBootRoster({ scope: "global", agents: [{ id: "main" }, { id: "work" }] });
  pane.presented = false;
  const release = sessions.subscribe(pane.applySessionsState.bind(pane));
  try {
    await refreshCurrentChatSessionList(state);
    const refresh = refreshPageChat(state, {
      awaitHistory: true,
      deferBranches: true,
      scheduleScroll: false,
    });
    if (workRefresh !== "none") {
      await refreshCurrentChatSessionList(state);
    }
    if (moveRoster) {
      await sessions.refresh({ agentId: "main", force: true });
    }
    const primaryDefaults = sessions.state.result?.defaults;
    const historyRow = {
      ...initialWork,
      ...(workRefresh === "none" ? { contextTokens: 1500, label: "History Work label" } : {}),
    };
    pendingHistory.resolve({
      defaults: {
        contextTokens: null,
        model: "model-old",
        modelProvider: "test",
        modelSelectionTarget: "agent",
      },
      messages: [{ role: "assistant", content: "History really applied" }],
      sessionInfo: historyRow,
    });
    await refresh;
    expect(state.chatMessages).toEqual([{ role: "assistant", content: "History really applied" }]);
    expect(state.sessionsResultAgentId).toBe("work");
    if (moveRoster) {
      expect(sessions.state.result?.sessions[0]).toEqual(mainRow);
      expect(sessions.state.result?.defaults).toEqual(primaryDefaults);
      expect(state.sessionsResult?.defaults.modelSelectionTarget).toBe("agent");
    }
    expect(selectedChatSessionRow(state)).toMatchObject(
      workRefresh === "updated" ? newerWork : historyRow,
    );
  } finally {
    release();
    sessions.dispose();
  }
});
