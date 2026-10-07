/* @vitest-environment jsdom */

import { html, render } from "lit";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createGatewayBrowserClientFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { SubagentRoster } from "./chat-spawned-subagent.ts";
import { renderChatComposerNotices } from "./chat-view-notices.ts";
import type { ChatChildAttention } from "./components/chat-child-attention.ts";

type ChildRosterPane = TestChatPane & {
  resolveChatReadTarget: () => { sessionKey: string; agentId?: string } | undefined;
  projectChildRoster: (
    target: { sessionKey: string; agentId?: string } | undefined,
  ) => SubagentRoster;
};

it.each([
  { routeKey: "global", mainKey: "main", scope: "global", parentKey: "agent:work:global" },
  {
    routeKey: "primary",
    mainKey: "primary",
    scope: "per-sender",
    parentKey: "agent:work:primary",
  },
] as const)(
  "renders child attention for admitted $routeKey ancestry",
  async ({ routeKey, mainKey, scope, parentKey }) => {
    vi.useFakeTimers();
    const fixture = createTestChatPane({ client: createGatewayBrowserClientFixture() });
    const pane = fixture.pane as ChildRosterPane;
    pane.state.sessionKey = routeKey;
    pane.state.assistantAgentId = "work";
    pane.state.agentsList = { defaultId: "work", mainKey, scope, agents: [] };
    const child = {
      key: "agent:work:subagent:diagnostic",
      kind: "direct",
      spawnedBy: parentKey,
      label: "Diagnostic",
      agentStatus: {
        note: "Blocked: diagnostic needs attention.",
        attention: "key",
        expiresAt: Date.now() + 60_000,
      },
    } satisfies GatewaySessionRow;
    Reflect.set(pane, "swarmHydrator", { rows: [child], hydrated: true });
    Reflect.set(pane, "swarmEnabled", false);
    const container = document.body.appendChild(document.createElement("div"));
    try {
      const roster = pane.projectChildRoster(pane.resolveChatReadTarget());
      expect(roster).toMatchObject({
        subagentParentKey: parentKey,
        subagentSessions: [child],
        subagentSessionsHydrated: true,
        swarm: undefined,
      });
      render(
        renderChatComposerNotices({ sessionKey: routeKey, messages: [], ...roster }),
        container,
      );
      const notice = container.querySelector<ChatChildAttention>("openclaw-chat-child-attention");
      expect(notice).not.toBeNull();
      await notice!.updateComplete;
      expect(notice!.querySelector(".chat-child-attention")?.textContent).toContain(
        child.agentStatus.note,
      );
      expect(pane.projectChildRoster(undefined)).toMatchObject({
        subagentParentKey: undefined,
        subagentSessions: undefined,
        subagentSessionsHydrated: false,
      });
    } finally {
      render(html``, container);
      container.remove();
      Reflect.set(pane, "swarmHydrator", null);
      vi.useRealTimers();
    }
  },
);
