/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult as sessionListFixture,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

const requireRecord = createRequireRecord("object", "expected-label");

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestIdleCallback", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scoped chat history defaults and row ordering", () => {
  it.each([
    {
      name: "same-owner equal timestamp control",
      moveRoster: false,
      historyUpdatedAt: 10,
      workRefresh: "updated",
    },
    {
      name: "different-owner older timestamp control",
      moveRoster: true,
      historyUpdatedAt: 9,
      workRefresh: "updated",
    },
    {
      name: "different-owner equal timestamp regression",
      moveRoster: true,
      historyUpdatedAt: 10,
      workRefresh: "updated",
    },
    {
      name: "prestarted history preserves newer Work descriptor",
      moveRoster: true,
      historyUpdatedAt: 10,
      workRefresh: "updated",
      prestartedHistory: true,
    },
    {
      name: "missing Work row remains admissible",
      moveRoster: true,
      historyUpdatedAt: 10,
      workRefresh: "missing",
    },
    {
      name: "Main-only publication does not freeze Work history",
      moveRoster: true,
      historyUpdatedAt: 10,
      workRefresh: "none",
    },
  ])("$name", async ({ moveRoster, historyUpdatedAt, workRefresh, prestartedHistory }) => {
    vi.stubGlobal("requestIdleCallback", vi.fn());
    const pendingHistory = createDeferred<ChatHistoryResult>();
    const initialWork: GatewaySessionRow = {
      key: "global",
      kind: "global",
      sessionId: "work-incarnation",
      updatedAt: 10,
      label: "Original Work label",
      modelProvider: "test",
      model: "model-old",
      contextTokens: 1000,
      totalTokens: 10,
      hasActiveRun: false,
      status: "done",
    };
    const newerWork: GatewaySessionRow = {
      ...initialWork,
      label: "Newer Work label",
      model: "model-new",
      contextTokens: 2000,
    };
    const mainRow: GatewaySessionRow = {
      key: "global",
      kind: "global",
      sessionId: "main-incarnation",
      updatedAt: 10,
      label: "Main stays Main",
      modelProvider: "test",
      model: "model-main",
      hasActiveRun: false,
      status: "done",
    };
    let workListCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        expect(params).toMatchObject({ sessionKey: "agent:work:main", agentId: "work" });
        return pendingHistory.promise;
      }
      if (method === "sessions.list") {
        const agentId = requireRecord(params, "session list params").agentId;
        if (agentId === "work") {
          workListCount += 1;
          return sessionListFixture(
            workListCount === 1 ? [initialWork] : workRefresh === "missing" ? [] : [newerWork],
            workListCount,
          );
        }
        if (agentId === "main") {
          return sessionListFixture([mainRow], 3);
        }
      }
      throw new Error(`Unexpected RPC ${method}: ${JSON.stringify(params)}`);
    });
    const client = createTestGatewayClient(request);
    const harness = createGatewayHarness(client);
    const sessions = createTestSessionCapability(harness.gateway);
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "agent:work:main";
    state.assistantAgentId = "work";
    state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }, { id: "work" }],
    };
    state.sessionsResult = null;
    state.sessionsResultAgentId = null;
    state.chatMessagesBySession = new Map();
    pane.presented = false;
    const release = sessions.subscribe(pane.applySessionsState.bind(pane));
    try {
      await refreshCurrentChatSessionList(state);
      expect(selectedChatSessionRow(state)).toMatchObject(initialWork);
      const previousSessionsResult = state.sessionsResult;
      const issuedRevision = sessions.canonicalListRevision;
      const refreshOptions = {
        awaitHistory: true,
        deferBranches: true,
        scheduleScroll: false,
      };
      let refresh = prestartedHistory ? undefined : refreshPageChat(state, refreshOptions);
      // Both paths use the real request observation, including a load begun before refresh.
      const historyLoad = loadChatHistory(state, { deferBranches: true });
      expect(getChatHistoryLoadState(state).phase).toBe("in-flight");
      if (workRefresh !== "none") {
        await refreshCurrentChatSessionList(state);
        expect(state.sessionsResult).not.toBe(previousSessionsResult);
      }
      if (workRefresh === "updated") {
        expect(selectedChatSessionRow(state)).toMatchObject(newerWork);
      }
      if (workRefresh === "missing") {
        expect(selectedChatSessionRow(state)).toBeUndefined();
      }
      const publishedWorkProjection = state.sessionsResult;
      if (moveRoster) {
        await sessions.refresh({ agentId: "main", force: true });
        expect(sessions.state.agentId).toBe("main");
        expect(state.sessionsResult).toBe(publishedWorkProjection);
        expect(state.sessionsResultAgentId).toBe("work");
      }
      refresh ??= refreshPageChat(state, { ...refreshOptions, historyLoad });
      const primaryDefaults = sessions.state.result?.defaults;
      const historyRow = {
        ...initialWork,
        updatedAt: historyUpdatedAt,
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
      await historyLoad;
      await refresh;
      const afterResolution = selectedChatSessionRow(state);
      expect(getChatHistoryLoadState(state).phase).toBe("committed");
      expect(state.chatMessages).toEqual([
        { role: "assistant", content: "History really applied" },
      ]);
      expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
      expect(sessions.canonicalListRevision).toBeGreaterThan(issuedRevision);
      if (moveRoster) {
        expect(sessions.state.result?.sessions[0]).toEqual(mainRow);
        expect(sessions.state.result?.defaults).toEqual(primaryDefaults);
        expect(
          expectDefined<SessionsListResult>(state.sessionsResult, "work session result").defaults
            .modelSelectionTarget,
        ).toBe("agent");
      }
      expect(afterResolution).toMatchObject(workRefresh === "updated" ? newerWork : historyRow);
    } finally {
      release();
      pane.disconnectedCallback();
      sessions.dispose();
    }
  });
});
