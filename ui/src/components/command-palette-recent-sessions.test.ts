/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import {
  buildCommandPaletteRecentItems,
  CommandPaletteRecentSessions,
  RECENT_SESSION_LIMIT,
} from "./command-palette-recent-sessions.ts";
import "./command-palette.tsx";
import {
  createContext,
  createGateway,
  mountPalette,
  openPalette,
  paletteInput,
  pressKey,
  registerCommandPaletteTestHooks,
  searchPalette,
} from "./command-palette.test-support.ts";

const NOW = 1_000_000;

function row(key: string, activityAt: number, extra: Partial<GatewaySessionRow> = {}) {
  return {
    key,
    kind: "direct",
    displayName: key.split(":").at(-1),
    updatedAt: activityAt,
    lastActivityAt: activityAt,
    ...extra,
  } as GatewaySessionRow;
}

function build(rows: GatewaySessionRow[], currentSessionKey = "") {
  return buildCommandPaletteRecentItems({
    rows,
    currentSessionKey,
    defaultAgentId: "main",
    now: NOW,
  });
}

describe("buildCommandPaletteRecentItems", () => {
  it("lists unread chats first, then other chats, each by latest activity", () => {
    const items = build([
      row("agent:main:read-new", 900),
      row("agent:main:unread-old", 100, { unread: true }),
      row("agent:main:read-old", 200),
      row("agent:main:unread-new", 800, { unread: true }),
    ]);
    expect(items.map((item) => [item.label, item.category])).toEqual([
      ["unread-new", "unread"],
      ["unread-old", "unread"],
      ["read-new", "recent"],
      ["read-old", "recent"],
    ]);
    expect(items[0]!.action).toBe("session:agent:main:unread-new");
  });

  it("leaves out the open chat, archived, snoozed, cron, and subagent sessions", () => {
    const items = build(
      [
        row("agent:main:open", 990, { unread: true }),
        row("agent:main:archived", 980, { unread: true, archived: true }),
        row("agent:main:snoozed", 970, { unread: true, snoozedUntil: NOW + 1 }),
        row("agent:main:woke", 960, { unread: true, snoozedUntil: NOW - 1 }),
        row("agent:main:cron:nightly", 950, { unread: true }),
        row("agent:main:subagent:helper", 940, { unread: true }),
        row("agent:main:dock", 930, { isDock: true }),
        row("agent:main:kept", 920),
      ],
      "agent:main:open",
    );
    expect(items.map((item) => item.label)).toEqual(["woke", "kept"]);
  });

  it("keeps at most the limit, preferring unread chats", () => {
    const rows = Array.from({ length: RECENT_SESSION_LIMIT + 4 }, (_, index) =>
      row(`agent:main:chat-${index}`, 1_000 - index, { unread: index >= 6 }),
    );
    const items = build(rows);
    expect(items).toHaveLength(RECENT_SESSION_LIMIT);
    expect(items.filter((item) => item.category === "unread")).toHaveLength(6);
  });
});

describe("CommandPaletteRecentSessions", () => {
  const input = {
    open: true,
    onSelectSession: () => undefined,
    currentSessionKey: () => "",
    defaultAgentId: "main",
  };
  const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the sidebar's chats while the Gateway reconnects", async () => {
    const roster = sessionsResult(
      [
        row("agent:main:reply", 900, { unread: true }),
        row("agent:main:quiet", 800),
      ] as GatewaySessionRow[],
      2,
    );
    const request = vi.fn(async (method: string) =>
      method === "sessions.list"
        ? roster
        : method === "sessions.subscribe"
          ? { subscribed: true }
          : {},
    );
    const harness = createGatewayHarness(
      { request } as unknown as GatewayBrowserClient,
      undefined,
      {
        selfUser: { id: "profile-one" },
      },
    );
    const sessions = createTestSessionCapability(harness.gateway);
    await sessions.refresh();
    const recent = new CommandPaletteRecentSessions();
    const asContext = sessions as unknown as ApplicationContext["sessions"];
    expect(labels(recent.read(asContext, input))).toEqual(["reply", "quiet"]);

    harness.publish(false);
    expect(sessions.state.result).toBeNull();
    expect(labels(recent.read(asContext, input))).toEqual(["reply", "quiet"]);
    recent.dispose();
  });

  it("shows a snoozed chat again once its snooze ends while the palette stays open", () => {
    vi.useFakeTimers({ now: NOW });
    const result = sessionsResult([
      row("agent:main:later", 900, { unread: true, snoozedUntil: NOW + 5_000 }),
      row("agent:main:kept", 800),
    ] as GatewaySessionRow[]);
    const sessions = {
      revision: 1,
      state: { result },
      presentation: { result },
    } as unknown as ApplicationContext["sessions"];
    const onDeadline = vi.fn();
    const recent = new CommandPaletteRecentSessions(onDeadline);
    expect(labels(recent.read(sessions, input))).toEqual(["kept"]);

    vi.advanceTimersByTime(5_000);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onDeadline).toHaveBeenCalledOnce();
    expect(labels(recent.read(sessions, input))).toEqual(["later", "kept"]);
    recent.dispose();
  });
});

describe("CommandPalette quick switcher", () => {
  registerCommandPaletteTestHooks();

  async function mountWithRoster(rows: GatewaySessionRow[], currentSessionKey = "") {
    const context = createContext(createGateway(true).gateway);
    const listeners = new Set<() => void>();
    let revision = 0;
    const publishRoster = (next: GatewaySessionRow[]) => {
      const result = { ts: 1, path: "", count: next.length, defaults: {}, sessions: next };
      Object.assign(context.sessions, {
        revision: ++revision,
        state: { result },
        presentation: { result },
      });
      for (const listener of listeners) {
        listener();
      }
    };
    Object.assign(context.sessions, {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    publishRoster(rows);
    const mounted = await mountPalette(context);
    mounted.palette.currentSessionKey = () => currentSessionKey;
    return { publishRoster, ...mounted };
  }

  const options = (palette: HTMLElement) =>
    [...palette.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
      option.querySelector(".cmd-palette__item-title")?.textContent?.trim(),
    );

  it("opens on the newest unread chat and selects it with Enter", async () => {
    const { palette } = await mountWithRoster(
      [
        row("agent:main:here", 990),
        row("agent:main:quiet", 900),
        row("agent:main:reply", 800, { unread: true }),
      ],
      "agent:main:here",
    );
    await openPalette(palette);

    expect(options(palette).slice(0, 3)).toEqual(["reply", "quiet", "New session"]);
    const groups = [...palette.querySelectorAll(".cmd-palette__group-label")].map((label) =>
      label.firstChild?.textContent?.trim(),
    );
    expect(groups.slice(0, 2)).toEqual(["Unread", "Recent"]);
    const first = palette.querySelector<HTMLElement>('[role="option"]')!;
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(first.classList.contains("cmd-palette__item--unread")).toBe(true);
    expect(first.querySelector(".session-unread-dot")).not.toBeNull();

    pressKey(paletteInput(palette), "Enter");
    await palette.updateComplete;
    expect(palette.onSelectSession).toHaveBeenCalledExactlyOnceWith("agent:main:reply");
    expect(palette.isOpen).toBe(false);
  });

  it("follows roster publications while open and hides chats once a query is typed", async () => {
    const rows = [row("agent:main:alpha", 900), row("agent:main:bravo", 800)];
    const { publishRoster, palette } = await mountWithRoster(rows);
    await openPalette(palette);
    expect(options(palette).slice(0, 2)).toEqual(["alpha", "bravo"]);

    publishRoster([rows[0]!, row("agent:main:bravo", 950, { unread: true })]);
    await palette.updateComplete;
    expect(options(palette).slice(0, 2)).toEqual(["bravo", "alpha"]);
    expect(palette.isOpen).toBe(true);

    await searchPalette(palette, "plugins");
    expect(options(palette)).not.toContain("alpha");
    expect(options(palette)).not.toContain("bravo");
  });
});
