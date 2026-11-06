import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { patchSettings } from "../../app/settings.ts";
export { activateSessionMenuValue as selectFilter } from "../app-sidebar-menu.ts";
import * as S from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";
import { nextFrame } from "../modal-dialog.ts";
import { flush } from "../solid-settle.ts";
import { agentList, sessionList } from "./compact.test-support.ts";

type Row = GatewaySessionRow;
export const roster = agentList([
  { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
  { id: "recent", name: "Scout" },
  { id: "working", name: "Forge" },
  { id: "system", name: "System helper", kind: "system" },
]);
export const owners = [
  { type: "human", id: "profile-ada", label: "Ada" },
  { type: "human", id: "profile-sam", label: "Sam" },
] as const;

export function session(agentId: string, updatedAt: number, extra: Partial<Row> = {}) {
  return {
    key: `agent:${agentId}:main`,
    agentId,
    isMain: true,
    kind: "direct",
    updatedAt,
    ...extra,
  } satisfies GatewaySessionRow;
}

export function patchRows(rows: Row[], key: string, patch: Partial<Row>) {
  return rows.map((row) => (row.key === key ? Object.assign({}, row, patch) : row));
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
      const preview = { lastMessagePreview: "Preparing the project summary." };
      const child = (id: string, label: string, age: number, owner: 0 | 1, extra: Partial<Row>) =>
        session(agent.id, updatedAt - age, {
          key: `agent:${agent.id}:${id}`,
          label: `${agent.name} ${label}`,
          isMain: false,
          owner: { actor: owners[owner] },
          ...extra,
        });
      return [
        session(agent.id, updatedAt - 300_000, preview),
        child("pinned", "project", 0, 0, {
          pinned: true,
          pinnedAt: updatedAt,
          hasActiveRun: agent.id === "working" || agent.kind === "system",
          ...preview,
        }),
        child("recent", "notes", 1_000, 1, { unread: agent.id === "main" }),
        child("archived", "archive", 2_000, 0, { archived: true, unread: true }),
      ];
    });
  const result: SessionsListResult = { ...sessionList(fixtureRows, now), owners: [...owners] };
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "sessions.list" || method === "sessions.subscribe") {
      return method === "sessions.list" ? result : { subscribed: true };
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
  const gatewayHarness = S.createGatewayHarness(createTestGatewayClient(request));
  const { gateway } = gatewayHarness;
  gateway.connection.gatewayUrl = gatewayUrl;
  patchSettings({ gatewayUrl });
  const sessions = S.createSessionsHarness("main", ["agent:main:main"]);
  sessions.list.mockImplementation((options) => {
    const children = options?.spawnedBy
      ? (childRows ?? result.sessions.filter((row) => row.spawnedBy === options.spawnedBy))
      : undefined;
    return Promise.resolve(
      children
        ? { ...result, sessions: children, count: children.length }
        : options?.archivedFilter === "all" && !options.agentId
          ? result
          : sessions.sessions.state.result,
    );
  });
  const mainRows = fixtureRows.filter((row) => row.agentId === "main");
  sessions.publish({ result: { ...result, count: mainRows.length, sessions: mainRows } });
  const mounted = await S.mountSidebar(gateway, sessions.sessions, "panel", agents, approvalQueue);
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  return { ...mounted, sessions, request, gatewayHarness, result };
}

export async function settleRoster(sidebar: S.SidebarLifecycleState) {
  if ("__vitest_browser__" in globalThis) {
    await nextFrame();
  }
  await sidebar.updateComplete;
  await vi.dynamicImportSettled();
  flush();
  await sidebar.updateComplete;
}

function dataValues(sidebar: HTMLElement, selector: string, key: string) {
  return Array.from(sidebar.querySelectorAll<HTMLElement>(selector), (row) => row.dataset[key]);
}
export const agentIds = (sidebar: HTMLElement) =>
  dataValues(sidebar, ".sidebar-agent-roster__row", "agentId");
export const sessionKeys = (sidebar: HTMLElement) =>
  dataValues(sidebar, ".sidebar-recent-session", "sessionKey");

export async function toggleRoster(sidebar: HTMLElement, agentId = "main") {
  const trigger = expectDefined(
    sidebar.querySelector<HTMLButtonElement>(
      ".sidebar-agent-card__main, .sidebar-workspace-header__main",
    ),
    "Missing agent switch control",
  );
  const value = sidebar.querySelector(".sidebar-workspace-header__main")
    ? `agent:${encodeURIComponent(agentId)}`
    : "scope:all";
  trigger.click();
  const selector = `.sidebar-agent-menu [data-value="${value}"]`;
  await vi.waitFor(() => expect(sidebar.querySelector(selector)).not.toBeNull());
  sidebar.querySelector<HTMLElement>(selector)?.click();
}
