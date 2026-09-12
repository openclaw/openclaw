import { expect, vi } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { patchSettings } from "../../app/settings.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";

export const roster: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
    { id: "recent", name: "Scout" },
    { id: "working", name: "Forge" },
    { id: "system", name: "System helper", kind: "system" },
  ],
};
export const owners = [
  { type: "human", id: "profile-ada", label: "Ada" },
  { type: "human", id: "profile-sam", label: "Sam" },
] as const;

export function session(
  agentId: string,
  updatedAt: number,
  extra: Partial<GatewaySessionRow> = {},
) {
  return {
    key: `agent:${agentId}:main`,
    agentId,
    isMain: true,
    kind: "direct",
    updatedAt,
    ...extra,
  } satisfies GatewaySessionRow;
}

export async function mountRoster(
  agents = roster,
  rows?: GatewaySessionRow[],
  gatewayUrl = "ws://gateway.test",
  lineageRows: GatewaySessionRow[] = [],
  approvalQueue: readonly import("../../app/exec-approval.ts").ExecApprovalRequest[] = [],
  childRows?: GatewaySessionRow[],
) {
  const now = Date.now();
  const fixtureRows =
    rows ??
    agents.agents.flatMap((agent, index) => {
      const updatedAt = now - (index + 1) * 60_000;
      return [
        session(agent.id, updatedAt - 300_000, {
          lastMessagePreview: "Preparing the project summary.",
        }),
        session(agent.id, updatedAt, {
          key: `agent:${agent.id}:pinned`,
          label: `${agent.name} project`,
          isMain: false,
          pinned: true,
          pinnedAt: updatedAt,
          owner: { actor: owners[0] },
          hasActiveRun: agent.id === "working" || agent.kind === "system",
          lastMessagePreview: "Preparing the project summary.",
        }),
        session(agent.id, updatedAt - 1_000, {
          key: `agent:${agent.id}:recent`,
          label: `${agent.name} notes`,
          isMain: false,
          owner: { actor: owners[1] },
          unread: agent.id === "main",
        }),
        session(agent.id, updatedAt - 2_000, {
          key: `agent:${agent.id}:archived`,
          label: `${agent.name} archive`,
          isMain: false,
          archived: true,
          unread: true,
          owner: { actor: owners[0] },
        }),
      ];
    });
  const result: SessionsListResult = {
    ts: now,
    path: "",
    count: fixtureRows.length,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    owners: [...owners],
    sessions: fixtureRows,
  };
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "sessions.list") {
      return result;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (
      method === "sessions.describe" &&
      typeof params === "object" &&
      params !== null &&
      "key" in params
    ) {
      const key = params.key;
      const row = lineageRows.find((entry) => entry.key === key);
      if (row) {
        return { session: row };
      }
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const gatewayHarness = createGatewayHarness(createTestGatewayClient(request));
  const { gateway } = gatewayHarness;
  gateway.connection.gatewayUrl = gatewayUrl;
  patchSettings({ gatewayUrl });
  const sessions = createSessionsHarness("main", ["agent:main:main"]);
  if (childRows) {
    sessions.list.mockResolvedValue({ ...result, sessions: childRows, count: childRows.length });
  }
  const mainRows = fixtureRows.filter((row) => row.agentId === "main");
  sessions.publish({ result: { ...result, count: mainRows.length, sessions: mainRows } });
  const mounted = await mountSidebar(gateway, sessions.sessions, "panel", agents, approvalQueue);
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  return { ...mounted, sessions, request, gatewayHarness, result };
}

export function agentIds(sidebar: HTMLElement) {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-roster__row")].map(
    (row) => row.dataset.agentId,
  );
}

export function sessionKeys(sidebar: HTMLElement) {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session")].map(
    (row) => row.dataset.sessionKey,
  );
}

export async function toggleRoster(sidebar: HTMLElement) {
  const trigger = sidebar.querySelector<HTMLButtonElement>(
    ".sidebar-agent-card__main, .sidebar-workspace-header__main",
  );
  if (!trigger) {
    throw new Error("Missing agent switch control");
  }
  trigger.click();
  await vi.waitFor(() => {
    expect(sidebar.querySelector('[value="command:sidebar-agents"]')).not.toBeNull();
  });
  const item = sidebar.querySelector('[value="command:sidebar-agents"]');
  sidebar
    .querySelector(".sidebar-agent-menu")
    ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));
}

export async function selectFilter(sidebar: SidebarLifecycleState, value: string) {
  sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")?.click();
  await vi.waitFor(() => {
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).not.toBeNull();
  });
  sidebar
    .querySelector(".sidebar-session-sort-menu")
    ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } }, bubbles: true }));
  await sidebar.updateComplete;
}
