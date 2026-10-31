/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { SubagentRoster } from "./chat-spawned-subagent.ts";

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
  "projects the child roster for admitted $routeKey ancestry",
  async ({ routeKey, mainKey, scope, parentKey }) => {
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
    try {
      const roster = pane.projectChildRoster(pane.resolveChatReadTarget());
      expect(roster).toMatchObject({
        subagentParentKey: parentKey,
        subagentSessions: [child],
        subagentSessionsHydrated: true,
      });
      expect(pane.projectChildRoster(undefined)).toMatchObject({
        subagentParentKey: undefined,
        subagentSessions: undefined,
        subagentSessionsHydrated: false,
      });
    } finally {
      Reflect.set(pane.swarm, "hydrator", null);
    }
  },
);
