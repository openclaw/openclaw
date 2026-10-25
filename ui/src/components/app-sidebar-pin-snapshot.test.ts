/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { sidebarSnapshotWithRows } from "./sidebar-snapshot.test-support.ts";

async function pinLookup() {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ selfUser: { id: "self", name: "Self" } });
  const sessions = createSessionsHarness("main", [
    "agent:main:main",
    "agent:main:mine",
    "agent:main:other",
  ]);
  const result = sessions.sessions.state.result!;
  result.owners = [
    { type: "human", id: "self", label: "Self" },
    { type: "human", id: "other", label: "Other" },
  ];
  for (const row of result.sessions) {
    row.owner = {
      actor: { type: "human", id: row.key.endsWith(":mine") ? "self" : "other" },
    };
  }
  const mounted = await mountSidebar(gateway.gateway, sessions.sessions);
  const { sidebar } = mounted;
  sidebar.connected = true;
  sidebar.sidebarEntries = [];
  sidebar.onUpdateSidebarEntries = (entries) => {
    sidebar.sidebarEntries = entries;
  };
  await sidebar.updateComplete;
  const key = "agent:other:unloaded";
  const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
  const read = vi.spyOn(sessions.sessions, "describe").mockReturnValue(pending.promise);
  return { ...mounted, key, pending, read, result };
}

function cachedPin(key: string) {
  return projectSidebarSession({ key, label: "Saved title", pinned: true });
}

type Sidebar = Awaited<ReturnType<typeof mountSidebar>>["sidebar"];
async function update(sidebar: Sidebar, properties: Partial<Sidebar>) {
  Object.assign(sidebar, properties);
  await sidebar.updateComplete;
}

it.each(["avatars", "artwork"] as const)(
  "retains cached pin %s through handoff until its descriptor arrives",
  async (presentation) => {
    const { sidebar, context, key, pending, read, result } = await pinLookup();
    const idleCallbacks: IdleRequestCallback[] = [];
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) =>
      idleCallbacks.push(callback),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const entry = `session:${key}`;
    const artwork = presentation === "artwork";
    const cached = {
      ...cachedPin(key),
      worktreeId: "cached-worktree",
      icon: artwork ? "📝" : undefined,
      unread: !artwork,
      hasActiveRun: artwork,
      isRunVisuallyActive: artwork,
      status: artwork ? ("queued" as const) : ("done" as const),
      participants: [
        {
          identity: { type: "profile" as const, id: "cached-participant" },
          label: "Cached Participant",
        },
      ],
      participantCount: 1,
    };
    const saved = sidebarSnapshotWithRows([cached], () => ({
      owner: {
        type: "human" as const,
        id: "cached-owner",
        identity: { type: "profile" as const, id: "cached-owner" },
        label: "Cached Owner",
      },
      attribution: "owned" as const,
      viewers: [],
      pullRequest: { numbers: [42], state: "open" as const },
      pullRequestCount: 3,
    }));
    await update(sidebar, { sidebarEntries: [entry], sidebarAgentsMode: "chip" });
    sidebar.restoreSidebarSnapshot({
      ...sidebarBootSnapshot(captureBootRoster(context.sessions.state)),
      mode: "chip",
      entries: [entry],
      rows: saved.rows,
      pinnedSessions: saved.sessions,
    });
    sidebar.invalidate();
    await sidebar.updateComplete;
    expect(sidebar.sidebarSnapshot).not.toBeNull();
    expect(
      [...sidebar.querySelectorAll("[data-session-key]")].map((element) =>
        element.getAttribute("data-session-key"),
      ),
    ).toContain(key);
    const row = () =>
      sidebar.querySelector(`[data-session-section="pinned"] [data-session-key="${key}"]`)!;
    const visible = () => ({
      label: row().querySelector(".sidebar-recent-session__title-row")?.textContent,
      avatars: [...row().querySelectorAll(".viewer-avatar--session")].map((avatar) =>
        avatar.getAttribute("aria-label"),
      ),
      icon: row().querySelector(".session-glyph__emoji")?.textContent,
      unread: Boolean(row().querySelector(".session-glyph__badge--unread")),
      queued: Boolean(row().querySelector(".session-glyph__ring--queued")),
      pullRequest: row().querySelector(".session-row-badge--pull-request")?.textContent,
    });
    const expected = {
      label: "Saved title",
      avatars: artwork ? [] : ["Cached Participant", "Cached Owner"],
      icon: artwork ? "📝" : undefined,
      unread: !artwork,
      queued: artwork,
      pullRequest: "3",
    };
    expect(visible()).toEqual(expected);

    for (const callback of idleCallbacks.splice(0)) {
      callback({ didTimeout: false, timeRemaining: () => 50 });
    }
    await sidebar.updateComplete;
    expect(sidebar.sidebarSnapshot).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith({ key });
    expect(visible()).toEqual(expected);

    pending.resolve({
      session: {
        ...result.sessions[1]!,
        key,
        label: "Current pin",
        icon: "🚀",
        unread: false,
        hasActiveRun: false,
        status: "done",
        participants: [],
        participantCount: 0,
      },
    });
    await pending.promise;
    await settleLitElement(sidebar);
    expect(visible()).toEqual({
      label: "Current pin",
      avatars: [],
      icon: "🚀",
      unread: false,
      queued: false,
      pullRequest: undefined,
    });
    expect(read).toHaveBeenCalledTimes(1);
  },
);
