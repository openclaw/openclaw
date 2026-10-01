import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { buildSessionListParams } from "../lib/sessions/session-requests.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import type { SidebarSessionStatusFilter } from "./app-sidebar-session-types.ts";

function project(rows: GatewaySessionRow[], statusFilter: SidebarSessionStatusFilter, now = 100) {
  return projectSidebarArchiveVisibility({
    sessionData: {
      sessionsAgentId: "main",
      sessionsResult: sessionsResult(rows, now),
      sessionResultsByAgent: {},
      childSessionRowsByParent: {},
      loadedChildSessionKeys: new Set(),
      loadingChildSessionKeys: new Set(),
      childSessionErrorsByParent: new Map(),
    },
    selectedAgentId: "main",
    statusFilter,
    now,
    deletionState: () => undefined,
    archiveVisibility: (key) =>
      rows.find((row) => row.key === key)?.archived ? "archived" : undefined,
  });
}

afterEach(() => vi.useRealTimers());

describe("sidebar snooze visibility", () => {
  const rows: GatewaySessionRow[] = [
    { key: "awake", kind: "direct" },
    { key: "snoozed", kind: "direct", snoozedUntil: 200, pinned: true },
    { key: "expired", kind: "direct", snoozedUntil: 100 },
    { key: "archived", kind: "direct", archived: true, snoozedUntil: 200 },
  ];
  it.each([
    ["active", ["awake", "expired"]],
    ["snoozed", ["snoozed"]],
    ["archived", ["archived"]],
    ["all", ["awake", "snoozed", "expired", "archived"]],
  ] as const)("shows the expected rows in %s", (filter, keys) => {
    expect(project(rows, filter).rows.map((row) => row.key)).toEqual(keys);
  });

  it("requests the same active lifecycle window for Snoozed and Active", () => {
    expect(buildSessionListParams({ archivedFilter: "snoozed", agentId: "main" })).toEqual(
      buildSessionListParams({ archivedFilter: "active", agentId: "main" }),
    );
  });

  it("applies snooze and wake publications immediately without a pending visibility state or list read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const row: GatewaySessionRow = {
      key: "agent:main:snooze",
      sessionId: "snooze-id",
      kind: "direct",
      updatedAt: 100,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([row], 100);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = createTestGatewayClient(request);
    const { sessions, emitEvent } = createSessionCapabilityHarness(client.request.bind(client));
    await sessions.refresh({ agentId: "main", force: true });
    const reads = request.mock.calls.filter(([method]) => method === "sessions.list").length;
    for (const snoozed of [true, false]) {
      const changed = {
        ...row,
        updatedAt: snoozed ? 101 : 102,
        ...(snoozed ? { snoozedUntil: 200, snoozedAt: 101 } : {}),
      };
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: row.key,
          reason: "patch",
          ts: changed.updatedAt,
          session: changed,
          ancestorSessions: [],
        },
      });
      expect(
        project(sessions.state.result?.sessions ?? [], "active").rows.map((entry) => entry.key),
      ).toEqual(snoozed ? [] : [row.key]);
      expect(sessions.archiveVisibility(row.key)).toBeUndefined();
    }
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(reads);
  });
});
