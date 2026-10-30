import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { sessionListResult } from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { resetChatComposerState } from "./components/chat-composer.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return sessionListResult(1, rows);
}

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatComposerState();
  resetTranscriptTestDom();
  vi.restoreAllMocks();
});

describe.each([false, true])("chat run activity (recovery ready: %s)", (recoveryScopeReady) => {
  it.each([
    {
      name: "shows a completed parent waiting on its child roster",
      selectedKey: "agent:main:main",
      parentActive: false,
      // Until its own child query answers, preserve the generic recovery status.
      expectWorking: recoveryScopeReady,
    },
    {
      name: "shows activity on the visible child itself",
      selectedKey: "agent:main:subagent:attachment-fix",
      parentActive: false,
      expectWorking: true,
    },
    {
      name: "shows activity while the parent has its own live turn",
      selectedKey: "agent:main:main",
      parentActive: true,
      expectWorking: true,
    },
  ])("$name", ({ selectedKey, parentActive, expectWorking }) => {
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
      startedAt: 1_000,
      endedAt: parentActive ? undefined : 2_000,
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

    const container = createApplicationContextProvider(context);
    renderChatPropsInto(container, expectDefined(pane.chatProps, "chat props"), context);

    expect(pane.chatProps?.canAbort).toBe(true);
    expect(
      container.querySelector(
        ".chat-working-indicator:not(.chat-working-indicator--subagents) .chat-reading-indicator",
      ) !== null,
    ).toBe(expectWorking);
    expect(container.querySelector(".chat-working-indicator--subagents")).toBeNull();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
  });
});

describe("composer run status", () => {
  it.each(["editable", "view-only subagent", "read-only shared"] as const)(
    "keeps %s child counts and the request timer through roster hydration and settlement",
    async (access) => {
      vi.spyOn(Date, "now").mockReturnValue(66_500);
      const parent: GatewaySessionRow = {
        key: access === "view-only subagent" ? "agent:main:subagent:parent" : "agent:main:parent",
        kind: "direct",
        ...(access === "read-only shared"
          ? { visibility: "read-only" as const, sharingRole: "viewer" as const }
          : {}),
        hasActiveRun: false,
        hasActiveSubagentRun: true,
        startedAt: 1_000,
        endedAt: 2_500,
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
      const container = createApplicationContextProvider(context);
      const onOpenSubagents = vi.fn();
      const draw = async (children: GatewaySessionRow[], hydrated = true) => {
        renderChatPropsInto(
          container,
          {
            ...expectDefined(pane.chatProps, "chat props"),
            selectedSession: parent,
            messages: [
              { role: "user", content: "Implement the backend.", timestamp: 1_500 },
              {
                role: "assistant",
                runId: "parent-run",
                timestamp: 2_000,
                content: [
                  { type: "text", text: "The backend work is delegated." },
                  { type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} },
                ],
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
            subagentSessionsHydrated: hydrated,
            onOpenSubagents,
          },
          context,
        );
        flush();
        expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
      };
      await draw([], false);
      expect(
        container.querySelector(".chat-working-indicator .chat-reading-indicator"),
      ).not.toBeNull();
      await draw([child]);
      await vi.dynamicImportSettled();
      flush();
      if (access === "view-only subagent") {
        expect(container.querySelector(".agent-chat__disabled-banner")?.textContent).toContain(
          "View-only subagent",
        );
        expect(container.querySelector(".agent-chat__composer-combobox")).toBeNull();
      }
      expect(container.querySelector(".chat-working-indicator .chat-reading-indicator")).toBeNull();
      expect(container.querySelector(".chat-subagent-activity")).toBeNull();
      expect(container.querySelector("openclaw-working-phrase")).toBeNull();
      // A handoff's wait names the session it waits on in place of a running count.
      const wait = () =>
        container.querySelector(".chat-subagent-wait")?.textContent?.replace(/\s+/gu, " ").trim();
      expect(wait()).toBe("Waiting on Backend implementation · 1m 5s");
      expect(container.querySelector(".chat-working-indicator__subagents")).toBeNull();
      const timer = container.querySelector(".chat-working-indicator openclaw-elapsed-time");
      expect(timer?.textContent).toBe("1m 5s");

      await draw([
        child,
        { ...child, key: "agent:main:subagent:frontend", label: "Frontend implementation" },
      ]);
      expect(
        container
          .querySelector(".chat-subagent-wait button[aria-expanded]")
          ?.textContent?.replace(/\s+/gu, " ")
          .trim(),
      ).toBe("Waiting on 2 sessions · 1m 5s");
      expect(
        container.querySelectorAll(".chat-working-indicator openclaw-elapsed-time"),
      ).toHaveLength(1);
      expect(container.querySelector(".chat-subagent-activity")).toBeNull();

      await draw([{ ...child, hasActiveRun: false }]);
      expect(container.querySelector(".chat-subagent-activity")).toBeNull();
      expect(container.querySelector(".chat-subagent-wait")).toBeNull();
    },
  );

  it("keeps the composer free of duplicate working status across run and access states", () => {
    const { context } = createRefreshChatPane();
    const container = createComposerContainer();
    container.setContext(context);
    const props = createComposerProps();
    const draw = () => {
      renderComposerInto(container, props);
    };
    draw();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
    props.runActive = true;
    draw();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
    props.disabledBanner = {
      kind: "composer-replacement",
      text: "This conversation is view-only.",
    };
    draw();
    expect(container.querySelector(".agent-chat__composer-combobox")).toBeNull();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
    props.waitingApproval = true;
    draw();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
    props.waitingApproval = false;
    props.runStatus = { phase: "done", runId: "work", sessionKey: props.sessionKey, occurredAt: 1 };
    draw();
    expect(container.querySelector(".agent-chat__composer-run-status")).toBeNull();
  });
});

describe("resumed handoff list", () => {
  it("re-renders a settled row when a listed child's name or attention changes", () => {
    const parent: GatewaySessionRow = { key: "agent:main:parent", kind: "direct", endedAt: 4_100 };
    const child: GatewaySessionRow = {
      key: "agent:main:subagent:docs",
      kind: "direct",
      spawnedBy: parent.key,
      label: "Docs",
      status: "done",
      startedAt: 2_100,
      endedAt: 3_000,
    };
    const acknowledgment = "Started the docs session.";
    const yieldCall = {
      type: "toolCall",
      id: "yield",
      name: "sessions_yield",
      arguments: { acknowledgment },
    };
    const messages = [
      { role: "assistant", runId: "parent-run", timestamp: 1_900, content: [yieldCall] },
      {
        role: "toolResult",
        runId: "parent-run",
        toolCallId: "yield",
        toolName: "sessions_yield",
        timestamp: 2_000,
        content: [{ type: "text", text: JSON.stringify({ status: "yielded", acknowledgment }) }],
      },
      { role: "assistant", runId: "resumed-run", timestamp: 4_000, content: "Docs are ready." },
    ];
    const { pane, state, context } = createRefreshChatPane();
    state.sessionKey = parent.key;
    state.sessionsResult = sessionsResult([parent]);
    pane.render();
    const container = createApplicationContextProvider(context);
    // Each draw passes the same transcript, so only the roster can refresh the row.
    const draw = (row: GatewaySessionRow) => {
      const props = { selectedSession: parent, messages, subagentSessions: [row] };
      const chatProps = expectDefined(pane.chatProps, "chat props");
      renderChatPropsInto(
        container,
        { ...chatProps, ...props, subagentSessionsHydrated: true },
        context,
      );
      flush();
      const collapsed = ".chat-handoff-resume button[aria-expanded=false]";
      container.querySelector<HTMLButtonElement>(collapsed)?.click();
      flush();
      const rows = container.querySelectorAll(".chat-handoff-resume li");
      return [...rows].map((item) => item.textContent?.replace(/\s+/gu, " ").trim());
    };
    expect(draw(child)).toEqual(["Docs Done"]);
    const renamed = { ...child, label: "Docs and changelog" };
    expect(draw(renamed)).toEqual(["Docs and changelog Done"]);
    const agentStatus = {
      note: "Pick a release note",
      attention: "hand" as const,
      expiresAt: 9e15,
    };
    expect(draw({ ...renamed, agentStatus })).toEqual(["Docs and changelog Needs your input"]);
  });
});
