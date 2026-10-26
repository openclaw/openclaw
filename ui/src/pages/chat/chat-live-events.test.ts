// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const pendingImport = vi.hoisted(() => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  return { held, started, release, start, dispatchImports: 0 };
});
vi.mock("./chat-live-events.runtime.ts", async (importOriginal) => {
  pendingImport.dispatchImports += 1;
  pendingImport.start();
  await pendingImport.held;
  return importOriginal();
});

async function harness() {
  const { makeChatHost } = await import("./chat-host.test-support.ts");
  const { handlePageGatewayEvent } = await import("./chat-state-events.ts");
  const host = makeChatHost({
    sessionKey: "agent:main:main",
    connectionEpoch: 1,
    requestHandlers: { "chat.history": { messages: [], sessionId: "selected-session" } },
  });
  const state = {
    ...host,
    currentSessionId: "selected-session",
    chatMessagesBySession: new Map(),
    pendingSessionMessageReloadSessionKey: null,
    observerDigest: null,
    knownAgentRunIds: new Set(),
    waitingApprovalStatuses: new Map(),
    waitingApprovalResolvedIds: new Set(),
    guardianNotices: [],
    compactionStatus: null,
  } as unknown as ChatPageHost;
  const send = (event: string, payload: unknown, row?: GatewaySessionRow) =>
    handlePageGatewayEvent(
      state,
      { type: "event", event, payload },
      () => false,
      row ? { applied: true, row } : { applied: false },
    );
  const chat = (runId: string, phase: string, text: string) =>
    send("chat", {
      sessionKey: state.sessionKey,
      runId,
      state: phase,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  return { state, send, chat };
}

function activeHistory(key: string, runId: string, content: string, text: string) {
  return {
    messages: [{ role: "user", content }],
    sessionId: "selected-session",
    sessionInfo: {
      key,
      sessionId: "selected-session",
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    },
    inFlightRun: {
      runId,
      text,
      events: [{ runId, seq: 1, stream: "usage", ts: 1, data: { outputTokens: 3 } }],
    },
  };
}

it("preserves live ordering across one shared import and retires superseded pane/snapshot work", async () => {
  const boundary = await import("./chat-live-events.ts");
  const { chatRunPresentation } = await import("./chat-run-presentation.ts");
  const foreground = await harness();
  chatRunPresentation(foreground.state);
  const streamWrites = vi.spyOn(foreground.state, "chatStream", "set");
  foreground.chat("run-1", "delta", "First token");
  foreground.send("agent", {
    sessionKey: foreground.state.sessionKey,
    runId: "run-1",
    seq: 1,
    stream: "usage",
    ts: 1,
    data: { outputTokens: 3 },
  });
  for (const phase of ["start", "end"]) {
    foreground.send("session.operation", {
      sessionKey: foreground.state.sessionKey,
      operation: "compact",
      operationId: "compact-1",
      phase,
      completed: false,
    });
  }
  foreground.chat("run-1", "final", "Complete answer");

  const resetPanes = [];
  for (const reason of ["reset", "new", "rewind", "branch-switch"]) {
    const pane = await harness();
    pane.chat("retired-run", "delta", "Retired reply");
    pane.send("sessions.changed", { key: pane.state.sessionKey, reason });
    resetPanes.push(pane);
  }
  const foreign = await harness();
  foreign.chat("run-1", "delta", "Current reply");
  foreign.send("sessions.changed", { key: "agent:main:fork", reason: "fork" });

  const terminalPanes = [];
  for (const includeFinal of [false, true]) {
    const pane = await harness();
    pane.chat("settled-run", "delta", "Already settled");
    if (includeFinal) {
      pane.chat("settled-run", "final", "Durable final");
    }
    const row: GatewaySessionRow = {
      key: pane.state.sessionKey,
      sessionId: pane.state.currentSessionId!,
      kind: "direct",
      updatedAt: 2,
      lastRunId: "settled-run",
      hasActiveRun: false,
      status: "done",
    };
    pane.send("sessions.changed", { ...row, reason: "agent.run.ended" }, row);
    terminalPanes.push(pane);
  }

  const retiredPanes = [];
  for (const change of ["connection", "session", "physical-session", "agent", "dispose"]) {
    const pane = await harness();
    if (change === "agent") {
      pane.state.sessionKey = "global";
      pane.state.assistantAgentId = "main";
    }
    pane.chat("stale-run", "delta", "Wrong owner");
    if (change === "connection") {
      pane.state.connectionEpoch += 1;
    }
    if (change === "session") {
      pane.state.sessionKey = "agent:main:other";
    }
    if (change === "physical-session") {
      pane.state.currentSessionId = "successor-session";
    }
    if (change === "agent") {
      pane.state.assistantAgentId = "other";
    }
    if (change === "dispose") {
      boundary.disposeChatLiveEvents(pane.state);
    }
    retiredPanes.push(pane);
  }

  const tools = await import("./chat-live-tools.ts");
  const loadToolsNow = tools.loadChatLiveTools;
  const loadTools = vi.spyOn(tools, "loadChatLiveTools").mockImplementation(async () => {
    await pendingImport.held;
    return loadToolsNow();
  });
  const history = await harness();
  const { loadChatHistory } = await import("./chat-history.ts");
  vi.spyOn(history.state.client!, "request").mockResolvedValue(
    activeHistory(history.state.sessionKey, "history-run", "Old history", "Old snapshot"),
  );
  const loadingHistory = loadChatHistory(history.state);
  const cutHistories = [];
  for (const reason of ["reset", "new", "rewind", "branch-switch"]) {
    const pane = await harness();
    vi.spyOn(pane.state.client!, "request")
      .mockResolvedValueOnce(
        activeHistory(
          pane.state.sessionKey,
          "pre-cut-run",
          "Before transcript cut",
          "Old branch reply",
        ),
      )
      .mockResolvedValue({ messages: [], sessionId: "selected-session" });
    cutHistories.push({ pane, reason, loading: loadChatHistory(pane.state) });
  }
  await vi.waitFor(() => expect(loadTools).toHaveBeenCalledTimes(5));
  for (const { pane, reason } of cutHistories) {
    expect(pane.state.chatRunId, `before ${reason}`).toBeNull();
    pane.send("sessions.changed", { key: pane.state.sessionKey, reason });
  }
  // Wait until history joins the held tool import before retiring its connection.
  await pendingImport.started;
  expect(history.state.chatMessages).toEqual([]);
  expect(history.state.chatRunId).toBeNull();
  history.state.connectionEpoch += 1;
  expect(foreground.state.chatRunId).toBeNull();

  pendingImport.release();
  await vi.waitFor(() => expect(streamWrites).toHaveBeenCalledWith("First token"));
  await loadingHistory;
  await Promise.all(cutHistories.map(({ loading }) => loading));
  expect(foreground.state.chatRunUsageById?.get("run-1")?.outputTokens).toBe(3);
  expect(foreground.state.chatRunId).toBeNull();
  expect(JSON.stringify(foreground.state.chatMessages)).toContain("Complete answer");
  expect(foreground.state.compactionStatus).toBeNull();
  foreground.chat("run-2", "delta", "Next run is synchronous");
  expect(foreground.state.chatStream).toBe("Next run is synchronous");
  expect(pendingImport.dispatchImports).toBe(1);
  expect(foreign.state.chatRunId).toBe("run-1");
  expect(foreign.state.chatStream).toBe("Current reply");
  for (const pane of [...resetPanes, ...terminalPanes, ...retiredPanes]) {
    expect(pane.state).toMatchObject({ chatRunId: null, chatStream: null });
  }
  expect(JSON.stringify(terminalPanes[1]!.state.chatMessages)).toContain("Durable final");
  expect(history.state).toMatchObject({ chatMessages: [], chatRunId: null });
  for (const { pane, reason } of cutHistories) {
    expect(JSON.stringify(pane.state.chatMessages), reason).not.toContain("Before transcript cut");
    expect(pane.state.chatRunId, reason).toBeNull();
    expect(pane.state.chatStream).toBeNull();
    await loadChatHistory(pane.state);
    expect(pane.state.chatMessages).toEqual([]);
  }
});
