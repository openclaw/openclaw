/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChat } from "./chat-view.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}

describe.each([false, true])("chat run activity (recovery ready: %s)", (recoveryScopeReady) => {
  afterEach(() => resetChatComposerState());

  it.each([
    {
      name: "shows a completed parent waiting on its visible child, not working",
      selectedKey: "agent:main:main",
      parentActive: false,
      expectWorking: false,
      expectWaiting: true,
    },
    {
      name: "shows activity on the visible child itself",
      selectedKey: "agent:main:subagent:attachment-fix",
      parentActive: false,
      expectWorking: true,
      expectWaiting: false,
    },
    {
      name: "shows activity while the parent has its own live turn",
      selectedKey: "agent:main:main",
      parentActive: true,
      expectWorking: true,
      expectWaiting: false,
    },
  ])("$name", ({ selectedKey, parentActive, expectWorking, expectWaiting }) => {
    const parentKey = "agent:main:main";
    const childKey = "agent:main:subagent:attachment-fix";
    const parent = {
      key: parentKey,
      kind: "direct",
      updatedAt: 2,
      status: parentActive ? "running" : "done",
      hasActiveRun: parentActive,
      activeRunIds: parentActive ? ["parent-run"] : [],
      hasActiveSubagentRun: true,
      childSessions: [childKey],
    } satisfies GatewaySessionRow;
    const child = {
      key: childKey,
      kind: "direct",
      updatedAt: 3,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["child-run"],
      subagentRunState: "active",
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      startedAt: 1,
    } satisfies GatewaySessionRow;
    const client = {
      request: async () => ({}),
      recoveryScopeReady,
    } as unknown as GatewayBrowserClient;
    const { pane, state, context } = createRefreshChatPane(client);
    context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
    state.sessionKey = selectedKey;
    state.sessionsResult = sessionsResult([parent, child]);
    pane.render();

    const container = document.createElement("div");
    render(renderChat(pane.chatProps!), container);

    expect(pane.chatProps?.canAbort).toBe(true);
    expect(
      container.querySelector(
        ".chat-working-indicator:not(.chat-working-indicator--subagents) .chat-reading-indicator",
      ) !== null,
    ).toBe(expectWorking);
    // Live transcript rows render once history has loaded; until then the skeleton owns the pane.
    expect(container.querySelector(".chat-working-indicator--subagents") !== null).toBe(
      expectWaiting && pane.chatProps?.loading !== true,
    );
  });
});

describe("composer run status", () => {
  afterEach(() => {
    resetChatComposerState();
    vi.restoreAllMocks();
  });

  it("shows the yielded parent's child count, name and run time, opens Subagents and clears after settlement", async () => {
    vi.spyOn(Date, "now").mockReturnValue(66_000);
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      kind: "direct",
      hasActiveRun: false,
      hasActiveSubagentRun: true,
      startedAt: 1_000,
    };
    const child: GatewaySessionRow = {
      key: "agent:main:subagent:backend",
      kind: "direct",
      spawnedBy: parent.key,
      label: "Backend implementation",
      hasActiveRun: true,
      startedAt: 5_000,
    };
    const { pane, state, context } = createRefreshChatPane();
    state.sessionKey = parent.key;
    state.sessionsResult = sessionsResult([parent]);
    pane.render();
    const container = document.body.appendChild(createApplicationContextProvider(context));
    const onOpenSubagents = vi.fn();
    onTestFinished(() => {
      render(nothing, container);
      container.remove();
      pane.chatProps?.transcript.hostDisconnected();
    });
    const draw = (children: GatewaySessionRow[]) =>
      render(
        renderChat({
          ...pane.chatProps!,
          selectedSession: parent,
          messages: [
            {
              role: "assistant",
              runId: "parent-run",
              timestamp: 2_000,
              content: [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
            },
            {
              role: "toolResult",
              runId: "parent-run",
              toolCallId: "yield",
              toolName: "sessions_yield",
              timestamp: 2_001,
              content: [{ type: "text", text: '{"status":"yielded"}' }],
            },
          ],
          subagentSessions: children,
          subagentSessionsHydrated: true,
          onOpenSubagents,
        }),
        container,
      );
    draw([child]);
    const line = container.querySelector(".agent-chat__composer-run-status--waiting");
    expect(line).not.toBeNull();
    const elapsed = line?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-elapsed-time",
    );
    await elapsed?.updateComplete;
    expect(line?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Waiting on 1 subagent · Backend implementation · running 1m 1s View",
    );
    expect(elapsed).toHaveProperty("startMs", 5_000);
    line?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onOpenSubagents).toHaveBeenCalledExactlyOnceWith(true);

    draw([
      child,
      { ...child, key: "agent:main:subagent:frontend", label: "Frontend implementation" },
    ]);
    expect(
      container.querySelector(".agent-chat__composer-run-status--waiting")?.textContent,
    ).toContain("Waiting on 2 subagents");
    expect(container.querySelector(".agent-chat__composer-wait-child")).toBeNull();

    draw([{ ...child, hasActiveRun: false }]);
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
  });

  it("shows Working only during the current run and leaves idle and approval states empty", () => {
    const container = document.createElement("div");
    onTestFinished(() => {
      render(nothing, container);
    });
    const props = createComposerProps();
    const draw = () => render(renderChatComposer(props), container);
    draw();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
    props.runActive = true;
    draw();
    expect(
      container.querySelector(".agent-chat__composer-footer .agent-chat__composer-run-status")
        ?.textContent,
    ).toContain("Working…");
    expect(
      container.querySelector(".agent-chat__composer-notices .agent-chat__composer-run-status"),
    ).toBeNull();
    props.waitingApproval = true;
    draw();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
    props.waitingApproval = false;
    props.runStatus = { phase: "done", runId: "work", sessionKey: props.sessionKey, occurredAt: 1 };
    draw();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
  });
});
