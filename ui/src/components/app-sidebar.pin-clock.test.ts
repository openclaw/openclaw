/* @vitest-environment jsdom */
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  click,
  rowLink,
  selectedRowKeys,
} from "../test-helpers/app-sidebar-cases/multi-select-support.ts";
import {
  mountRoster,
  roster,
  session,
  sessionKeys,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { openRowSessionMenu } from "../test-helpers/app-sidebar-menu.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";
import { menuItemLabels } from "../test-helpers/session-menu.ts";
import { storeSidebarSessionOwnerFilter } from "./app-sidebar-session-types.ts";
import { setSessionsStatusFilter } from "./session-organizer-menu.runtime.ts";

const wakeAt = 100_000;
const row = (id: string, snoozedUntil?: number, agentId = "main") =>
  session(agentId, 10, {
    key: `agent:${agentId}:${id}`,
    label: id,
    sessionId: id,
    isMain: false,
    snoozedUntil,
  });
const before = row("before");
const target = row("target", wakeAt);
const after = row("after");
const ordinary = row("ordinary", wakeAt);
const entries = (...rows: { key: string }[]) => rows.map(({ key }) => `session:${key}`);
// The paired browser follows its writable profile, not a native capability advertisement.
const hello = gatewayHelloForMethods(SESSION_MUTATION_TEST_METHODS);
const signed = { hello, selfUser: { id: "reader" } };
const negotiated = {
  ...hello,
  features: { methods: ["users.prefs.set"], capabilities: ["personal-session-pins"] },
};

async function mount(deviceTime: number, connection: Partial<ApplicationGatewaySnapshot> = signed) {
  vi.useFakeTimers();
  vi.setSystemTime(deviceTime);
  const rows = [before, target, after, ordinary];
  const fixture = await mountRoster(roster, rows, "ws://gateway.test", rows);
  const { gatewayHarness, sessions, sidebar, result } = fixture;
  if (connection.selfUser) {
    storeSidebarSessionOwnerFilter(
      gatewayHarness.gateway.connection.gatewayUrl,
      connection.selfUser.id,
      {
        ownerId: null,
        involvingMe: false,
      },
    );
  }
  gatewayHarness.publish(connection);
  const publish = async (ts: number) => {
    sessions.publishList({
      result: {
        ...result,
        ts,
        sessions: [
          { ...before, pinned: true },
          { ...target, pinned: ts >= wakeAt },
          { ...after, pinned: true },
          { ...ordinary, pinned: false },
        ],
      },
    });
    await settleRoster(sidebar);
  };
  sidebar.activeRouteId = "chat";
  sidebar.sessionKey = target.key;
  sidebar.sidebarEntries = entries(before, target, after);
  await publish(wakeAt - 1);
  return { ...fixture, publish };
}

const pinnedKeys = (sidebar: HTMLElement) =>
  [
    ...sidebar.querySelectorAll<HTMLElement>(
      '[data-session-section="pinned"] .sidebar-recent-session',
    ),
  ].map(({ dataset }) => dataset.sessionKey);
async function snoozeActions(sidebar: Awaited<ReturnType<typeof mountRoster>>["sidebar"]) {
  const menu = await openRowSessionMenu(sidebar, target.key);
  const labels = menuItemLabels(menu).filter((label) => /^(Wake session|Snooze)/.test(label));
  sidebar.dismissTransientMenus();
  return labels;
}

it.each([-60_000, 60_000])(
  "uses the current sidebar read for the selected saved pin (device offset %i ms)",
  async (offset) => {
    const { sidebar, publish } = await mount(wakeAt - 1 + offset);
    const ordinaryKeys = offset > 0 ? [ordinary.key] : [];
    expect(sessionKeys(sidebar)).toEqual([before.key, after.key, ...ordinaryKeys]);

    sidebar.sessionsStatusFilter = "all";
    await settleRoster(sidebar);
    expect(pinnedKeys(sidebar)).toEqual([before.key, after.key]);
    expect(sessionKeys(sidebar).filter((key) => key === target.key)).toEqual([target.key]);
    expect(rowLink(sidebar, target.key).getAttribute("aria-current")).toBe("page");
    expect(
      sidebar.querySelector(`[data-session-key="${target.key}"] .session-row-trail--snooze`),
    ).not.toBeNull();
    expect(await snoozeActions(sidebar)).toEqual([expect.stringMatching(/^Wake session/)]);
    sidebar.sessionsStatusFilter = "active";
    await settleRoster(sidebar);

    await publish(wakeAt);
    expect(pinnedKeys(sidebar)).toEqual([before.key, target.key, after.key]);
    expect(sessionKeys(sidebar)).toEqual([before.key, target.key, after.key, ...ordinaryKeys]);
    expect(rowLink(sidebar, target.key).getAttribute("aria-current")).toBe("page");
    expect(await snoozeActions(sidebar)).toEqual(["Snooze"]);
    click(rowLink(sidebar, before.key), { altKey: true });
    click(rowLink(sidebar, after.key), { shiftKey: true });
    await settleRoster(sidebar);
    expect(selectedRowKeys(sidebar)).toEqual([before.key, target.key, after.key]);

    // Edit the saved references without a new list: the previously ordinary row now uses Gateway time.
    sidebar.sidebarEntries = entries(after, ordinary, before);
    await settleRoster(sidebar);
    expect(pinnedKeys(sidebar)).toEqual([after.key, ordinary.key, before.key]);
    expect(sessionKeys(sidebar)).toEqual([
      after.key,
      ordinary.key,
      before.key,
      ...(offset > 0 ? [target.key] : []),
    ]);
  },
);

it("wakes a cross-agent pin on the all-agent roster read, not a primary sidebar publication", async () => {
  const { sidebar, sessions, result, publish } = await mount(wakeAt - 60_000);
  const crossAgent = row("cross-agent", wakeAt, "working");
  const rosterAnchor = row("roster-anchor", undefined, "working");
  let rosterTs = wakeAt - 20;
  sessions.list.mockImplementation(async (options) =>
    options?.source === "agent-roster"
      ? {
          ...result,
          ts: rosterTs,
          activityExpiresAt: rosterTs < wakeAt ? wakeAt - 1 : undefined,
          count: 3,
          sessions: [before, { ...crossAgent, pinned: rosterTs >= wakeAt }, rosterAnchor],
        }
      : sessions.sessions.state.result,
  );
  sidebar.sidebarEntries = entries(before, crossAgent, rosterAnchor);
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);
  await publish(wakeAt);
  await vi.advanceTimersByTimeAsync(19);
  expect(sessionKeys(sidebar)).toEqual([before.key, rosterAnchor.key]);
  rosterTs = wakeAt;
  await vi.advanceTimersByTimeAsync(2);
  await settleRoster(sidebar);
  expect(sessionKeys(sidebar)).toEqual([before.key, crossAgent.key, rosterAnchor.key]);
});

it.each([false, true])(
  "wakes a saved active reference outside the Archived query using its Gateway clock (wake read stalls: %s)",
  async (stall) => {
    const { sidebar, sessions, result } = await mount(wakeAt + 60_000);
    const archived = { ...row("archived"), archived: true };
    let ts = wakeAt - 100;
    let unavailableUntil = 0;
    sessions.list.mockImplementation(async (query) => {
      if (query?.archivedFilter !== "archived") {
        return sessions.sessions.state.result;
      }
      if (Date.now() < unavailableUntil) {
        throw new GatewayProtocolRequestTimeoutError({
          method: "sessions.list",
          timeoutMs: 30_000,
          requestSent: true,
        });
      }
      return { ...result, ts, sessions: [archived], count: 1 };
    });
    setSessionsStatusFilter(sidebar.sessionOrganizer, "archived");
    await vi.advanceTimersByTimeAsync(0);
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar)).toContain(archived.key);
    expect(pinnedKeys(sidebar)).not.toContain(target.key);
    const reads = () =>
      sessions.list.mock.calls.filter(([query]) => query?.archivedFilter === "archived").length;
    const beforeWake = reads();
    await vi.advanceTimersByTimeAsync(99);
    expect(reads()).toBe(beforeWake);
    ts = wakeAt;
    if (stall) {
      // A brief Gateway stall fails the wake read and any immediate repeat.
      unavailableUntil = Date.now() + 1_000;
    }
    await vi.advanceTimersByTimeAsync(2);
    await settleRoster(sidebar);
    expect(reads()).toBe(beforeWake + 1);
    if (stall) {
      expect(pinnedKeys(sidebar)).not.toContain(target.key);
      // The window's wake retry owns the next attempt and its pacing.
      await vi.advanceTimersByTimeAsync(5_000);
      await settleRoster(sidebar);
      expect(reads()).toBe(beforeWake + 2);
    }
    expect(pinnedKeys(sidebar)).toContain(target.key);
    expect(sessionKeys(sidebar)).toContain(archived.key);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(beforeWake + (stall ? 2 : 1));
  },
);

it.each([
  { name: "profileless", connection: { hello: negotiated, selfUser: null } },
  {
    name: "session-only writer",
    connection: {
      ...signed,
      hello: {
        ...negotiated,
        auth: { role: "operator", scopes: ["operator.read", "operator.sessions.write"] },
      },
    },
  },
  {
    name: "read-only",
    connection: {
      ...signed,
      hello: { ...negotiated, auth: { role: "operator", scopes: ["operator.read"] } },
    },
  },
])("keeps $name saved pins on the device clock", async ({ connection }) => {
  const { sidebar, publish } = await mount(wakeAt - 1_000, connection);
  await publish(wakeAt);
  expect(sessionKeys(sidebar)).toEqual([before.key, after.key]);
  await vi.advanceTimersByTimeAsync(1_001);
  await settleRoster(sidebar);
  expect(pinnedKeys(sidebar)).toEqual([before.key, target.key, after.key]);
});
