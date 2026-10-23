/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { SubagentRoster } from "./chat-spawned-subagent.ts";
import { renderChatComposerNotices } from "./chat-view-notices.tsx";

type ChildRosterPane = TestChatPane & {
  resolveChatReadTarget: () => { sessionKey: string; agentId?: string } | undefined;
  projectChildRoster: (
    target: { sessionKey: string; agentId?: string } | undefined,
  ) => SubagentRoster;
};

it("counts header subagents without projecting transcript history or child activity", () => {
  const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  let historyReads = 0;
  state.chatMessages = new Proxy([{ role: "user", content: "Delegate the check." }], {
    get(target, key, receiver) {
      historyReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const readActivity = vi.fn(() => undefined);
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:check",
    kind: "direct",
    spawnedBy: state.sessionKey,
    hasActiveRun: true,
    get observerDigest() {
      return readActivity();
    },
  };
  Reflect.set(pane.swarm, "hydrator", { rows: [child], hydrated: true, childrenRead: true });
  const header = pane.renderPaneHeader(
    createPaneHeaderWorkspaceFixture(state),
    { key: state.sessionKey, kind: "direct", hasActiveSubagentRun: true, startedAt: 1, endedAt: 2 },
    false,
    undefined,
    false,
    null,
  );
  Reflect.set(pane.swarm, "hydrator", null);
  expect(header.header.runningSubagentCount).toBe(1);
  expect({ history: historyReads, activity: readActivity.mock.calls.length }).toEqual({
    history: 0,
    activity: 0,
  });
});

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
    Reflect.set(pane.swarm, "hydrator", { rows: [child], hydrated: true, childrenRead: true });
    Reflect.set(pane.swarm, "enabled", false);
    const container = document.body.appendChild(document.createElement("div"));
    try {
      const roster = pane.projectChildRoster(pane.resolveChatReadTarget());
      expect(roster).toMatchObject({
        subagentParentKey: parentKey,
        subagentSessions: [child],
        subagentSessionsHydrated: true,
        subagentSessionsRead: true,
        swarm: undefined,
      });
      const view = mountSolid(
        () => renderChatComposerNotices({ sessionKey: routeKey, messages: [], ...roster }),
        { container },
      );
      const notice = container.querySelector<HTMLElement>("openclaw-chat-child-attention");
      expect(notice).not.toBeNull();
      flush();
      expect(notice!.querySelector(".chat-child-attention")?.textContent).toContain(
        child.agentStatus.note,
      );
      view.unmount();
      expect(pane.projectChildRoster(undefined)).toMatchObject({
        subagentParentKey: undefined,
        subagentSessions: undefined,
        subagentSessionsHydrated: false,
        subagentSessionsRead: false,
      });
    } finally {
      container.remove();
      Reflect.set(pane.swarm, "hydrator", null);
      vi.useRealTimers();
    }
  },
);
