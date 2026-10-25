/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../../lib/sessions/route-navigation.ts";
import { createContext, createGateway, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid as mountDashboards } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DashboardsView } from "../dashboards/view.tsx";
import { mountSolid, props, row } from "./session-activity-view.test-harness.ts";
import { renderSessionActivityView } from "./session-activity-view.tsx";

const renderSessionActivityViewSolid = mountSolid<ReturnType<typeof props>>(
  renderSessionActivityView,
  (input) => createSolidApplicationContextProvider(input.context).wrapper,
);

function find(selector: string, root: ParentNode = container) {
  return root.querySelector(selector);
}
function all(selector: string, root: ParentNode = container) {
  return root.querySelectorAll(selector);
}

const text = (selector: string, root: ParentNode | null | undefined = container) =>
  root?.querySelector(selector)?.textContent;

function profile(id: string, overrides: Partial<PresenceViewer> = {}) {
  return {
    id,
    identity: { type: "profile" as const, id },
    name: "Person",
    watchedSessions: [],
    ...overrides,
  };
}
function agentContext(
  agents: NonNullable<ApplicationContext["agents"]["state"]["agentsList"]>["agents"],
) {
  return createContext(
    createGateway(createTestGatewayClient(vi.fn(async () => ({})))),
    createSessions("main", []),
    { defaultId: "main", mainKey: "main", scope: "per-sender", agents },
  );
}

let container: HTMLDivElement;
function show(input: Parameters<typeof props>[0] = {}, target = container) {
  renderSessionActivityViewSolid(props(input), target);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  // Identity and navigation fixtures do not admit viewport-driven media discovery.
  vi.stubGlobal(
    "IntersectionObserver",
    class extends IntersectionObserver {
      override observe() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("session activity semantics", () => {
  afterEach(() => {
    setAvatarGatewayOrigin(null);
    vi.restoreAllMocks();
  });

  it.each([
    ["24h", "Last 24 hours", 25, new Date(2026, 0, 2), { hour: "numeric" }],
    ["7d", "Last 7 days", 8, new Date(2026, 0, 8), { month: "short", day: "numeric" }],
    ["all", "All time", 12, new Date(2026, 11, 1), { month: "short" }],
  ] as const)("renders the %s pulse with aligned labels", (time, label, count, last, format) => {
    const since = new Date(2026, 0, 1).getTime();
    const hourly = time === "24h";
    const buckets = Array.from({ length: count }, () => 1);
    if (hourly) {
      buckets.fill(0);
      buckets[10] = 12;
      buckets[24] = 3;
    }
    const input = props({ filters: { personId: null, query: "", time } });
    input.result!.activityPulse = {
      since,
      until:
        time === "24h"
          ? last.getTime() + 3_600_000
          : new Date(
              last.getFullYear(),
              last.getMonth() + (time === "all" ? 1 : 0),
              last.getDate() + (time === "all" ? 0 : 1),
            ).getTime(),
      buckets,
      sessions: 38,
      ...(hourly ? { started: 12, people: 6 } : {}),
      running: hourly ? 3 : 0,
    };
    show(input);
    const bars = all(".activity-pulse__bar");
    const formatter = new Intl.DateTimeFormat(undefined, format);
    expect(text(".activity-pulse__heading")?.trim()).toBe(label);
    expect(bars).toHaveLength(count);
    expect(bars[count - 1]?.getAttribute("data-bucket")).toBe("current");
    expect(bars[count - 1]?.getAttribute("title")).toBe(
      formatter.format(last) + (hourly ? " · 3 sessions" : " · 1 session"),
    );
    const labels = all(".activity-pulse__axis > span > span");
    expect(labels).toHaveLength(hourly ? 5 : 3);
    expect(labels[labels.length - 1]?.textContent).toBe(formatter.format(last));
    if (hourly) {
      expect(text(".activity-pulse__stats")?.replace(/\s+/g, " ").trim()).toBe(
        "38 sessions · 12 started · 6 people · 3 running now",
      );
      expect(find(".activity-pulse__running")).not.toBeNull();
      expect(find('[role="img"]')?.getAttribute("aria-label")).toBe(
        "Last 24 hours: 38 sessions; busiest " + formatter.format(new Date(2026, 0, 1, 10)),
      );
      expect(bars[10]?.getAttribute("style")).toContain("100%");
      expect(bars[24]?.getAttribute("style")).toContain("25%");
    } else {
      expect(find(".activity-pulse__running")).toBeNull();
    }
    show();
    expect(find(".activity-pulse")).toBeNull();
  });

  it.each([
    [0, "0 sessions", "0 people", false],
    [1, "1 session", "1 person", false],
    [1, "1 session", "1+ people", true],
  ] as const)("renders count %i (%s, %s, incomplete=%s)", (count, sessions, people, incomplete) => {
    const input = props({ filters: { personId: null, query: "", time: "all" } });
    input.result!.peopleIncomplete = incomplete;
    input.result!.activityPulse = {
      since: new Date(2026, 0, 1).getTime(),
      until: new Date(2027, 0, 1).getTime(),
      buckets: [count, 0],
      sessions: count,
      people: count,
      running: 0,
    };
    show(input);
    const period = new Intl.DateTimeFormat(undefined, { month: "short" }).format(
      new Date(2026, 0, 1),
    );
    expect(text(".activity-pulse__stats")?.replace(/\s+/g, " ").trim()).toBe(
      sessions + " · " + people + " · 0 running now",
    );
    expect(find('[role="img"]')?.getAttribute("aria-label")).toBe(
      "All time: " + sessions + "; busiest " + period,
    );
    expect(find(".activity-pulse__bar")?.getAttribute("title")).toBe(period + " · " + sessions);
    expect(all(".activity-pulse__stats > span")[1]?.hasAttribute("title")).toBe(incomplete);
    const note = find('.activity-feed__people-panel [role="status"]');
    if (incomplete) {
      expect(note?.textContent).toContain(
        "People and counts describe visible recorded session associations",
      );
      expect(all(".activity-pulse__stats > span")[1]?.getAttribute("title")).toBe(
        "People and counts describe visible recorded session associations; retained history and this people list may be incomplete.",
      );
      expect(find(".activity-feed__people-panel")?.lastElementChild).toBe(note);
      expect(text(".activity-feed__main")).not.toContain(
        "People and counts describe visible recorded session associations",
      );
      input.result!.peopleIncomplete = false;
      show(input);
      expect(find('.activity-feed__people-panel [role="status"]')).toBeNull();
    } else {
      expect(note).toBeNull();
    }
  });

  it("shows the list footer when matching sessions exceed the visible rows", () => {
    const input = props({ rows: [row("Visible session", { id: "owner" }, Date.now())] });
    input.result!.totalCount = 885;
    show(input);

    const main = find(".activity-feed__main")!;
    const footer = main.querySelector(".activity-feed__footer");
    expect(footer?.textContent).toBe("Showing 1 of 885");
    expect(main.lastElementChild).toBe(footer);
  });

  it.each(["stale sidebar", "catalog:native:gateway%3Alocal:Thread-1"] as const)(
    "opens displayed rows with configured routing for %s",
    (key) => {
      const stale = key === "stale sidebar";
      const rows = stale
        ? (["chat", "dashboard"] as const).map((face, index) =>
            row(
              `agent:research:${face}:12345678-90ab-cdef-1234-567890abcde${index}`,
              { id: "owner" },
              Date.now(),
              { boardFace: face, displayName: `Research ${face}` },
            ),
          )
        : [row(key, { id: "owner" }, Date.now())];
      const input = props({ rows });
      input.context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: stale ? "main" : "workspace",
        scope: "per-sender",
        agents: [],
      };
      input.context = {
        ...input.context,
        basePath: "/control",
        agentSelection: { state: { selectedId: stale ? "other" : "research" } },
        ...(stale
          ? {
              sessions: {
                state: {
                  agentId: "other",
                  result: {
                    sessions: rows.map((session) => ({ ...session, displayName: "Old title" })),
                  },
                },
              },
            }
          : {}),
      } as unknown as ApplicationContext;
      show(input);
      const links = container.querySelectorAll<HTMLAnchorElement>("[data-activity-session]");
      expect(links).toHaveLength(rows.length);
      for (const [index, session] of rows.entries()) {
        const link = links[index]!;
        const pathname = stale
          ? `/control/${session.boardFace}/research/research-${session.boardFace}-1234567890abcdef1234567890abcde${index}`
          : "/control/chat/research";
        const search = stale
          ? `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(session.key)}`
          : key.startsWith("catalog:")
            ? "?catalog=native&host=gateway%3Alocal&thread=Thread-1"
            : undefined;
        expect(link.getAttribute("href")).toBe(`${pathname}${stale ? "" : (search ?? "")}`);
        link.click();
        expect(input.context.navigate).toHaveBeenLastCalledWith(
          stale ? session.boardFace : "chat",
          search ? { pathname, search } : { pathname },
        );
      }
    },
  );

  it.each([
    ["activity", "global", false, null],
    ["activity", "global", true, "/chat/qa-writer"],
    ["dashboards", "global", false, null],
    ["dashboards", "global", true, "/dashboard/qa-writer"],
    ["dashboards", "agent:qa-writer:global", false, "/dashboard/qa-writer/~key/global"],
  ] as const)("%s preserves %s with global scope %s", (surface, key, globalScope, href) => {
    const input = props({
      rows: [
        row(key, { id: "owner" }, Date.now(), {
          agentId: "qa-writer",
          displayName: "Stored session",
        }),
      ],
    });
    input.context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: globalScope ? "global" : "per-sender",
      agents: [],
    };
    if (surface === "activity") {
      show(input);
    } else {
      mountDashboards(
        () =>
          createComponent(DashboardsView, {
            readReady: () => undefined,
            data: {
              result: input.result!,
              error: null,
              basePath: "",
              fallbackAgentId: "main",
              mainKey: "main",
              globalScope,
            },
            filters: { query: "", ownerId: "", sort: "updated" },
            handlers: { onFilterChange: vi.fn() },
          }),
        { container },
      );
    }
    const item = container.querySelector<HTMLElement>(
      surface === "activity" ? "[data-activity-session]" : ".dashboard-card__main",
    )!;
    expect(item.textContent).toContain("Stored session");
    expect(item.getAttribute("href")).toBe(href);
    if (surface === "activity") {
      if (!href) {
        item.click();
        expect(input.context.navigate).not.toHaveBeenCalled();
      }
    }
  });

  it("renders agent-owned sessions and profile pictures without making agents or channels people", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": url.endsWith("/avatar/research") ? "image/jpeg" : "image/png",
        },
      });
    });
    // Identify each image by its content type, not the order concurrent fetches finish.
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) =>
      "type" in blob && blob.type === "image/png" ? "blob:human" : "blob:agent",
    );
    const agent = {
      type: "agent" as const,
      id: "research",
      identity: { type: "agent" as const, id: "research" },
      avatarUrl: "/avatar/research",
    };
    const human = {
      type: "human" as const,
      id: "person",
      identity: { type: "profile" as const, id: "person" },
      label: "Person",
      avatarUrl: "/api/users/person/avatar",
    };
    const channel = {
      ...human,
      identity: { type: "legacy" as const, actorType: "human", source: "channel", id: "person" },
    };
    const rows = [
      row("Human session", human, 3, { owner: { actor: human }, channel: "discord" }),
      row("Agent session", agent, 2, { owner: { actor: agent } }),
      row("Unattributed session", agent, Date.now() - 2, {
        owner: undefined,
        createdActor: undefined,
        agentId: "research",
      }),
      row("Channel session", channel, 1, { owner: { actor: channel } }),
    ];
    const context = agentContext([
      { id: "main" },
      { id: "research", identity: { avatarUrl: "/avatar/research" } },
    ]);
    const input = props({ context, rows });
    input.result!.people = [
      {
        identity: human.identity,
        label: human.label,
        avatarUrl: human.avatarUrl,
        sessionCount: 1,
      },
    ];
    show(input);
    await waitForSolid(() => {
      expect(
        [
          '[data-activity-session="Human session"] img',
          '[data-activity-session="Agent session"] img',
          '[data-activity-person="person"] img',
          '[data-activity-session="Unattributed session"] openclaw-viewer-avatar img',
        ].map((selector) => find(selector)?.getAttribute("src")),
      ).toEqual(["blob:human", "blob:agent", "blob:human", "blob:agent"]);
      expect(find('[data-activity-person="research"]')).toBeNull();
      expect(text('[data-activity-session="Human session"]')).toContain("Channel: discord");
      expect(find('[data-activity-session="Channel session"] img')).toBeNull();
    });
  });
});

describe("session activity people filter", () => {
  it("groups connection diagnostics, orders known watched sessions, and scopes disclosure to the person", () => {
    const entry = {
      ts: 1,
      host: "openclaw-control-ui",
      clientId: "openclaw-control-ui",
      mode: "webchat",
      deviceFamily: "Mac",
      platform: "MacIntel",
      ip: "203.0.113.7",
      timeZone: "Europe/Vienna",
    };
    const person: PresenceViewer = {
      id: "online",
      identity: { type: "profile", id: "online" },
      email: "online@example.test",
      watchedSessions: ["agent:main:first", "agent:main:second", "missing"],
      entries: [
        entry,
        { ...entry, lastInputSeconds: 30 },
        { ...entry, lastInputSeconds: 5 },
        { ...entry, ip: "203.0.113.8" },
        { ts: 1, host: "Alice's Mac", platform: "Win32", deviceFamily: "Mac16,6" },
        { ts: 2, host: "Alice's phone" },
      ],
    };
    const input = props({
      filters: { personId: "online", query: "", time: "7d" },
      rows: ["first", "second", "unwatched"].map((name, index) =>
        row("agent:main:" + name, { id: "online" }, (index + 1) * 10),
      ),
      presenceViewers: [person],
    });
    show(input);
    expect(text('[data-activity-identity="online"] h2')).toBe("online@example.test");
    expect(text(".activity-feed__identity")).toContain("Online");
    const details = container.querySelector<HTMLDetailsElement>(
      ".activity-feed__connection-details",
    )!;
    expect(details.open).toBe(false);
    expect(text("summary", details)?.trim()).toBe("Connection details · 6");
    expect(
      [...all(".activity-feed__connection-summary span")].map((span) => span.textContent),
    ).toEqual(["Mac · Web app", "Mac16,6 · Windows"]);
    const groups = all(".activity-feed__connection");
    expect(groups).toHaveLength(4);
    expect(groups[0]?.textContent).toContain("3 connections");
    expect(groups[0]?.textContent).toContain("Last input 5s ago");
    expect(groups[0]?.textContent).toContain("203.0.113.7");
    expect(groups[0]?.textContent).toContain("Europe/Vienna");
    expect(groups[1]?.textContent).toContain("1 connection");
    expect(groups[1]?.textContent).toContain("203.0.113.8");
    expect([...groups].map((group) => text("strong", group))).toEqual([
      "Mac · Web app",
      "Mac · Web app",
      "Mac16,6 · Windows",
      "Alice's phone",
    ]);
    expect(
      [...all(".activity-feed__viewing-list [data-activity-session]")].map((session) =>
        session.getAttribute("data-activity-session"),
      ),
    ).toEqual(["agent:main:second", "agent:main:first"]);
    details.open = true;
    show({ ...input, presenceViewers: [{ ...person, entries: [entry] }] });
    expect(find("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(text("summary", details)?.trim()).toBe("Connection details · 1");
    show({
      ...input,
      filters: { ...input.filters, personId: "other" },
      presenceViewers: [{ ...person, id: "other", identity: { type: "profile", id: "other" } }],
    });
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
  });

  it("requires exact case when resolving a selected server profile facet", () => {
    const personId = "Offline";
    const input = props({
      filters: { personId, query: "", time: "7d" },
      rows: [
        row("Visible session", { id: personId, label: "Row actor" }, 10, {
          participants: [{ identity: { type: "profile", id: personId }, label: "Preview actor" }],
        }),
      ],
    });
    show({ ...input, result: undefined, loading: true });
    expect(find(".activity-feed__not-found")).toBeNull();
    expect(text('.activity-feed__loading [role="status"]')).toContain("Loading");

    show(input);
    expect(find(".activity-feed__not-found")).not.toBeNull();
    expect(find("[data-activity-identity]")).toBeNull();
    expect(find("[data-activity-session]")).toBeNull();
  });

  it("never joins raw presence into an online profile Activity page", () => {
    const input = props({
      filters: { personId: "online", query: "", time: "7d" },
      rows: [row("raw-watch", { id: "online" }, 10)],
      presenceViewers: [
        profile("online", { name: "Profile person", entries: [{ host: "Profile device", ts: 1 }] }),
        {
          id: "online",
          name: "Raw collider",
          watchedSessions: ["raw-watch"],
          entries: [{ host: "Raw device", ts: 1 }],
        },
      ],
    });
    show(input);
    const identity = find("[data-activity-identity]")!;
    expect(text("h2", identity)).toBe("Profile person");
    expect(text(".settings-status", identity)?.trim()).toBe("Online");
    expect(identity.textContent).not.toContain("Raw device");
    expect(identity.querySelector(".activity-feed__viewing-list")).toBeNull();
    expect(all(".activity-feed__people-row .activity-feed__presence-dot")).toHaveLength(1);
  });

  it("selecting Everyone clears the person while preserving the other filters", () => {
    const onFiltersChange = vi.fn();
    show({
      filters: { personId: "online", query: "release", time: "30d" },
      rows: [row("Release session", { id: "online", label: "Online person" }, Date.now())],
      onFiltersChange,
    });

    const trigger = container.querySelector<HTMLButtonElement>(".activity-feed__people-trigger");
    trigger?.click();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(find(".activity-feed__people-popover"));
    container.querySelector<HTMLButtonElement>('[data-activity-person=""]')?.click();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    expect(onFiltersChange).toHaveBeenCalledWith({
      personId: null,
      query: "release",
      time: "30d",
    });
  });
});

describe("session activity automation grouping", () => {
  it("groups bound automation separately from cron provenance and bypasses grouping for filters", () => {
    const now = new Date().setHours(12, 0, 0, 0);
    const owner = { id: "owner", label: "Owner" };
    const regular = row("Scheduled report", owner, now, { createdVia: "cron" });
    const automationOne = row("Automation one", owner, now - 1_000, { hasAutomation: true });
    const automationTwo = row("Automation two", owner, now - 2_000, { hasAutomation: true });
    const onAutomationDayToggle = vi.fn();

    show({ rows: [regular, automationOne, automationTwo], onAutomationDayToggle });

    const group = container.querySelector<HTMLButtonElement>("[data-activity-automation-group]");
    expect(group?.textContent).toContain("2 automation sessions");
    expect(group?.getAttribute("aria-expanded")).toBe("false");
    expect(all("[data-activity-session]")).toHaveLength(1);
    const dayKey = group?.dataset.activityAutomationGroup;
    expect(dayKey).toBeTruthy();
    group?.click();
    expect(onAutomationDayToggle).toHaveBeenCalledWith(dayKey);

    show({
      rows: [regular, automationOne, automationTwo],
      expandedAutomationDays: new Set([dayKey!]),
    });
    expect(all("[data-activity-session]")).toHaveLength(3);
    expect(
      text('[data-activity-session="Scheduled report"] [data-activity-created-via="cron"]')?.trim(),
    ).toContain("Automation");
    expect(find('[data-activity-session="Automation one"] [data-activity-created-via]')).toBeNull();

    show({ rows: [regular, automationOne] });
    expect(find("[data-activity-automation-group]")).toBeNull();
    expect(all("[data-activity-session]")).toHaveLength(2);

    for (const filteredProps of [
      { filters: { personId: null, query: "Automation", time: "7d" as const } },
      {
        filters: { personId: "owner", query: "", time: "7d" as const },
        presenceViewers: [
          {
            id: "owner",
            identity: { type: "profile" as const, id: "owner" },
            name: "Owner",
            watchedSessions: [],
          },
        ],
      },
    ]) {
      show({ rows: [automationOne, automationTwo], ...filteredProps });
      expect(find("[data-activity-automation-group]")).toBeNull();
      expect(all("[data-activity-session]")).toHaveLength(2);
    }
  });
});

describe("session activity live status", () => {
  it("shows status and inspector links only for exact active observer membership", () => {
    const now = Date.now();
    const owner = { id: "owner", label: "Owner" };
    const input = props();
    input.context = { ...input.context, basePath: "/control" };
    const digest = (runId: string) => ({
      headline: "  Waiting on a fake approval  ",
      health: "waiting-on-user" as const,
      revision: 1,
      runId,
      updatedAt: now,
    });
    const rows = [
      row("Digest run", owner, now, {
        activeRunIds: ["fallback-run", "digest run:a/b"],
        hasActiveRun: true,
        observerDigest: digest("digest run:a/b"),
      }),
      row("Stale digest", owner, now - 500, {
        activeRunIds: ["current-run"],
        hasActiveRun: true,
        observerDigest: digest("ended-run"),
      }),
      row("Active run fallback", owner, now - 1_000, {
        activeRunIds: ["fallback run:a/b"],
        hasActiveRun: true,
      }),
      row("Inactive run", owner, now - 2_000, {
        activeRunIds: ["inactive-run"],
        status: "running",
        observerDigest: digest("inactive-run"),
      }),
    ];
    show({ context: input.context, rows });
    expect(
      [...container.querySelectorAll<HTMLAnchorElement>(".activity-feed__inspect-run")].map(
        (link) => link.getAttribute("href"),
      ),
    ).toEqual(["/control/activity?view=run&run=digest%20run%3Aa%2Fb"]);
    const active = find('[data-activity-session="Digest run"]')!;
    expect(active.querySelector(".activity-feed__run-dot")).not.toBeNull();
    expect(active.querySelector(".activity-feed__session-headline")?.textContent?.trim()).toBe(
      "Waiting on a fake approval",
    );
    expect(
      active.querySelector(".activity-feed__session-headline")?.getAttribute("data-health"),
    ).toBe("waiting-on-user");
    expect(active.textContent).toContain("Owner");
    for (const key of ["Stale digest", "Active run fallback", "Inactive run"]) {
      expect(find(`[data-activity-session="${key}"] .activity-feed__session-headline`)).toBeNull();
    }
    expect(find('[data-activity-session="Inactive run"] .activity-feed__run-dot')).toBeNull();
  });
});
