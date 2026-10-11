/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../../lib/sessions/route-navigation.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createContext, createGateway, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid as mountDashboards } from "../../test-helpers/mount-solid.ts";
import { loadChatRoute } from "../chat/route-loader.ts";
import { DashboardsView } from "../dashboards/view.tsx";
import { mountSolid, props, row } from "./session-activity-view.test-harness.ts";
import { renderSessionActivityView } from "./session-activity-view.tsx";

const renderSessionActivityViewSolid = mountSolid(renderSessionActivityView);

let container: HTMLDivElement;
function show(input: Parameters<typeof props>[0] = {}, target = container) {
  renderSessionActivityViewSolid(props(input), target);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
});

describe("session activity semantics", () => {
  afterEach(() => {
    setAvatarGatewayOrigin(null);
    vi.restoreAllMocks();
  });

  it.each([
    [undefined, "Online"],
    [0, "Online · Active"],
    [120_000, "Online · Idle"],
  ])("separates online identity from interaction age %s", (age, label) => {
    const now = Date.now();
    show({
      rows: [row("agent:main:work", { id: "person" }, now)],
      filters: { personId: "person", query: "", time: "7d" },
      presenceViewers: [
        {
          id: "person",
          identity: { type: "profile", id: "person" },
          name: "Person",
          watchedSessions: [],
          entries: [
            {
              ts: now,
              lastInputSeconds: 0,
              lastActivityAt: age === undefined ? undefined : now - age,
            },
          ],
        },
      ],
    });
    expect(
      container.querySelector(".activity-feed__identity .settings-status")?.textContent?.trim(),
    ).toBe(label);
  });

  it("refreshes presence age without replacing the selected person's disclosure", () => {
    const now = Date.UTC(2026, 0, 1, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const person = {
      id: "person",
      identity: { type: "profile" as const, id: "person" },
      name: "Person",
      watchedSessions: [],
      entries: [{ ts: now, lastActivityAt: now, host: "Test device" }],
    };
    const input = props({
      filters: { personId: "person", query: "", time: "7d" },
      presenceViewers: [person],
      presentationRevision: 1,
    });
    show(input);
    const identity = container.querySelector(".activity-feed__identity");
    const details = container.querySelector<HTMLDetailsElement>(
      ".activity-feed__connection-details",
    )!;
    details.open = true;
    expect(identity?.querySelector(".settings-status")?.textContent).toContain("Online · Active");

    vi.mocked(Date.now).mockReturnValue(now + 120_000);
    show({ ...input, presentationRevision: 2 });
    expect(container.querySelector(".activity-feed__identity")).toBe(identity);
    expect(identity?.querySelector(".settings-status")?.textContent).toContain("Online · Idle");
    expect(container.querySelector(".activity-feed__connection-details")).toBe(details);
    expect(details.open).toBe(true);
  });

  it("leaves the page main landmark to the app shell", () => {
    show();

    expect(container.querySelectorAll("main")).toHaveLength(0);
  });

  it.each([
    {
      time: "24h",
      label: "Last 24 hours",
      count: 25,
      since: new Date(2026, 8, 26, 14),
      indices: [0, 6, 12, 18, 24],
    },
    { time: "7d", label: "Last 7 days", count: 8, since: new Date(2026, 2, 4), indices: [0, 4, 7] },
    {
      time: "30d",
      label: "Last 30 days",
      count: 31,
      since: new Date(2026, 2, 1),
      indices: [0, 8, 15, 23, 30],
    },
    { time: "all", label: "All time", count: 12, since: new Date(2025, 9, 1), indices: [0, 6, 11] },
  ] as const)(
    "renders the $time pulse, aligned buckets, and completeness",
    ({ time, label, count, since, indices }) => {
      const hourly = time === "24h";
      const bucketStart = (index: number) =>
        hourly
          ? since.getTime() + index * 3_600_000
          : new Date(
              since.getFullYear(),
              since.getMonth() + (time === "all" ? index : 0),
              since.getDate() + (time === "all" ? 0 : index),
            ).getTime();
      const input = props({
        rows: hourly
          ? [row("Recent session", { id: "owner" }, new Date(2026, 8, 27, 14, 30).getTime())]
          : [],
        filters: { personId: null, query: "", time },
      });
      const buckets: number[] = Array.from({ length: count }, () => (hourly ? 0 : 1));
      if (hourly) {
        buckets[10] = 12;
        buckets[24] = 3;
      }
      input.result!.activityPulse = {
        since: since.getTime(),
        until: bucketStart(count),
        buckets,
        sessions: hourly ? 38 : count,
        ...(hourly ? { started: 12, people: 6 } : {}),
        running: hourly ? 3 : 0,
      };
      show(input);
      const main = container.querySelector(".activity-feed__main")!;
      const pulse = main.querySelector(".activity-pulse")!;
      expect(main.firstElementChild).toBe(pulse);
      expect(pulse.querySelector(".activity-pulse__heading")?.textContent?.trim()).toBe(label);
      const bars = pulse.querySelectorAll(".activity-pulse__bars > span");
      expect(bars).toHaveLength(count);
      expect(pulse.querySelectorAll(".activity-pulse__axis > span")).toHaveLength(count);
      expect(bars[count - 1]?.getAttribute("data-bucket")).toBe("current");
      const options: Intl.DateTimeFormatOptions = hourly
        ? { hour: "numeric" }
        : time === "all"
          ? { month: "short" }
          : { month: "short", day: "numeric" };
      const formatter = new Intl.DateTimeFormat(undefined, options);
      expect(bars[count - 1]?.getAttribute("title")).toBe(
        `${formatter.format(bucketStart(count - 1))} · ${hourly ? 3 : 1} sessions`,
      );
      expect(
        [...pulse.querySelectorAll(".activity-pulse__axis > span > span")].map(
          (axis) => axis.textContent,
        ),
      ).toEqual(indices.map((index) => formatter.format(bucketStart(index))));
      if (hourly) {
        expect(
          pulse.querySelector(".activity-pulse__stats")?.textContent?.replace(/\s+/g, " ").trim(),
        ).toBe("38 sessions · 12 started · 6 people · 3 running now");
        expect(pulse.querySelector(".activity-pulse__running")).not.toBeNull();
        expect(pulse.querySelectorAll('[data-bucket="current"]')).toHaveLength(1);
        expect(pulse.querySelectorAll('[data-bucket="past"]')).toHaveLength(24);
        expect(pulse.querySelector('[data-bucket="future"]')).toBeNull();
        const peakHour = formatter.format(bucketStart(10));
        expect(pulse.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
          `Last 24 hours: 38 sessions; busiest ${peakHour}`,
        );
        expect(bars[10]?.getAttribute("title")).toBe(`${peakHour} · 12 sessions`);
        expect(bars[10]?.getAttribute("style")).toContain("100%");
        expect(bars[24]?.getAttribute("style")).toContain("25%");
        input.result!.peopleIncomplete = true;
        show(input);
        const peopleStat = pulse.querySelectorAll(".activity-pulse__stats > span")[2]!;
        const warning =
          "People and counts describe visible recorded session associations; retained history and this people list may be incomplete.";
        expect(peopleStat.querySelector("b")?.textContent?.trim()).toBe("6+");
        expect(peopleStat.getAttribute("title")).toBe(warning);
        const panel = container.querySelector(".activity-feed__people-panel")!;
        const note = panel.querySelector('[role="status"]');
        expect(note?.textContent).toContain(
          "People and counts describe visible recorded session associations",
        );
        expect(panel.lastElementChild).toBe(note);
        expect(main.textContent).not.toContain(
          "People and counts describe visible recorded session associations",
        );
        input.result!.peopleIncomplete = false;
        show(input);
        expect(panel.querySelector('[role="status"]')).toBeNull();
      }
      if (time === "all") {
        input.result!.activityPulse = {
          since: since.getTime(),
          until: bucketStart(count),
          buckets: buckets.map(() => 0),
          sessions: 0,
          running: 0,
        };
        show(input);
        expect(
          pulse.querySelector(".activity-pulse__stats")?.textContent?.replace(/\s+/g, " ").trim(),
        ).toBe("0 sessions · 0 running now");
        expect(pulse.querySelectorAll(".activity-pulse__bars > span")).toHaveLength(12);
        expect(pulse.querySelector(".activity-pulse__running")).toBeNull();
        show();
        expect(container.querySelector(".activity-pulse")).toBeNull();
      }
    },
  );

  it.each([1, 885])(
    "shows the list footer only when %s matching sessions exceed the visible rows",
    (totalCount) => {
      const input = props({ rows: [row("Visible session", { id: "owner" }, Date.now())] });
      input.result!.totalCount = totalCount;
      show(input);

      const main = container.querySelector(".activity-feed__main")!;
      const footer = main.querySelector(".activity-feed__footer");
      if (totalCount > 1) {
        expect(footer?.textContent).toBe("Showing 1 of 885");
        expect(main.lastElementChild).toBe(footer);
      } else {
        expect(footer).toBeNull();
      }
    },
  );

  it.each([
    "stale sidebar",
    "workspace",
    "global",
    "catalog:native:gateway%3Alocal:Thread-1",
  ] as const)("opens displayed rows with configured routing for %s", (key) => {
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
    input.context = {
      ...input.context,
      basePath: "/control",
      agents: {
        state: {
          agentsList: {
            defaultId: "main",
            mainKey: stale ? "main" : "workspace",
            scope: key === "global" ? "global" : "per-sender",
          },
        },
      },
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
  });

  it.each(
    (["activity", "dashboards"] as const).flatMap((surface) =>
      (
        [
          ["unknown", false, null],
          ["unknown", true, null],
          ["global", false, null],
          ["global", true, "global"],
          ["agent:qa-writer:global", false, "agent:qa-writer:global"],
        ] as const
      ).map(([key, globalScope, expectedKey]) => ({ surface, key, globalScope, expectedKey })),
    ),
  )(
    "$surface preserves $key identity with global scope $globalScope",
    async ({ surface, key, globalScope, expectedKey }) => {
      const session = row(key, { id: "owner" }, Date.now(), {
        agentId: "qa-writer",
        displayName: "Stored session",
      });
      const input = props({ rows: [session] });
      const agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: globalScope ? "global" : "per-sender",
      } as const;
      const request = vi.fn(async () => {
        throw new Error(
          "An exact Home or qualified literal open must not discover another session",
        );
      });
      input.context = {
        ...input.context,
        agents: { state: { agentsList: { ...agentsList, agents: [] } } },
        gateway: {
          ...input.context.gateway,
          snapshot: {
            ...input.context.gateway.snapshot,
            phase: "connected",
            client: createTestGatewayClient(request),
          },
        },
      } as unknown as ApplicationContext;
      const surfaceContainer = document.createElement("div");
      document.body.append(surfaceContainer);
      if (surface === "activity") {
        renderSessionActivityViewSolid(input, surfaceContainer);
      } else {
        mountDashboards(
          () =>
            createComponent(DashboardsView, {
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
          { container: surfaceContainer },
        );
      }
      const item = surfaceContainer.querySelector<HTMLElement>(
        surface === "activity" ? "[data-activity-session]" : ".dashboard-card__main",
      )!;
      expect(item.textContent).toContain("Stored session");
      if (surface === "activity") {
        expect(item.parentElement?.classList.contains("activity-feed__session-row--link")).toBe(
          Boolean(expectedKey),
        );
      }
      if (!expectedKey) {
        expect(item.hasAttribute("href")).toBe(false);
        item.click();
        expect(input.context.navigate).not.toHaveBeenCalled();
        return;
      }
      const href = item.getAttribute("href")!;
      const loaded = await loadChatRoute(
        input.context,
        { pathname: href, search: "", hash: "" },
        surface === "activity" ? "chat" : "dashboard",
        new AbortController().signal,
      );
      expect(loaded).toMatchObject({ kind: "session" });
      if (!("kind" in loaded) || loaded.kind !== "session") {
        throw new Error("Expected a loaded session");
      }
      expect(resolveUiConversationIdentity({ agentsList }, loaded.sessionKey)).toEqual({
        sessionKey: expectedKey,
        agentId: "qa-writer",
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

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
      label: "Research",
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
      row("Human session", human, Date.now(), { owner: { actor: human } }),
      row("Agent session", agent, Date.now() - 1, {
        owner: { actor: agent },
        createdActor: agent,
      }),
      row("Unattributed session", agent, Date.now() - 2, {
        owner: undefined,
        createdActor: undefined,
        agentId: "research",
      }),
      row("Channel session", channel, Date.now() - 3, {
        owner: { actor: channel },
        createdActor: channel,
      }),
    ];
    show({
      rows,
      result: {
        ts: 1,
        path: "",
        count: rows.length,
        sessions: rows,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        people: [
          {
            identity: human.identity,
            label: human.label,
            avatarUrl: human.avatarUrl,
            sessionCount: 1,
          },
        ],
      },
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-activity-session="Human session"] img')?.getAttribute("src"),
      ).toBe("blob:human");
      expect(
        container.querySelector('[data-activity-session="Agent session"] img')?.getAttribute("src"),
      ).toBe("blob:agent");
      expect(
        container.querySelector('[data-activity-person="person"] img')?.getAttribute("src"),
      ).toBe("blob:human");
      expect(container.querySelector('[data-activity-person="research"]')).toBeNull();
      expect(container.querySelector('[data-activity-session="Channel session"] img')).toBeNull();
      expect(
        container
          .querySelector('[data-activity-session="Unattributed session"] img')
          ?.getAttribute("src"),
      ).toBe("blob:agent");
    });
  });

  it("keeps human attribution beside the session agent's configured avatar and name", async () => {
    const context = createContext(
      createGateway(createTestGatewayClient(vi.fn(async () => ({})))),
      createSessions("main", []),
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "research", name: "Research partner", identity: { emoji: "🔬" } }],
      },
    );
    const providerContainer = createApplicationContextProvider(context);
    document.body.append(providerContainer);
    show(
      {
        context,
        rows: [
          row("agent:research:review", { id: "person", label: "Alex Morgan" }, Date.now(), {
            channel: "discord",
          }),
        ],
      },
      providerContainer,
    );

    await vi.waitFor(() => {
      const session = providerContainer.querySelector(
        '[data-activity-session="agent:research:review"]',
      );
      expect(session?.textContent).toContain("Alex Morgan");
      expect(session?.textContent).toContain("Channel: discord");
      expect(session?.textContent).not.toContain("Agent:");
      expect(
        session?.querySelector('[aria-label="Research partner (agent:research)"]'),
      ).not.toBeNull();
      expect(session?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
        "🔬",
      );
    });
  });
});

describe("session activity people filter", () => {
  it("groups matching connection facts while retaining network differences and person-scoped disclosure", () => {
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
    const person = {
      id: "online",
      identity: { type: "profile" as const, id: "online" },
      watchedSessions: [],
      entries: [
        entry,
        { ...entry, lastInputSeconds: 30 },
        { ...entry, lastInputSeconds: 5 },
        { ...entry, ip: "203.0.113.8" },
      ],
    };
    const input = props({
      filters: { personId: "online", query: "", time: "7d" },
      presenceViewers: [person],
    });
    show(input);
    expect(container.querySelector(".activity-feed__connection-summary")?.textContent).toBe(
      "Mac · Web app",
    );
    const details = container.querySelector<HTMLDetailsElement>(
      ".activity-feed__connection-details",
    )!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent?.trim()).toBe("Connection details · 4");
    const groups = details.querySelectorAll(".activity-feed__connection");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain("3 connections");
    expect(groups[0]?.textContent).toContain("Last input 5s ago");
    expect(groups[1]?.textContent).toContain("1 connection");
    expect(groups[1]?.textContent).toContain("203.0.113.8");
    details.open = true;
    show({ ...input, presenceViewers: [{ ...person, entries: [entry] }] });
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")?.textContent?.trim()).toBe("Connection details · 1");
    show({
      ...input,
      filters: { ...input.filters, personId: "other" },
      presenceViewers: [{ ...person, id: "other", identity: { type: "profile", id: "other" } }],
    });
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
  });

  it.each([false, true])(
    "keeps online identity details and only known watched sessions in recency order (facet present: %s)",
    (hasFacet) => {
      const input = props({
        filters: { personId: "online", query: "", time: "7d" },
        rows: [
          row("agent:main:first", { id: "online" }, 10),
          row("agent:main:second", { id: "online" }, 20),
          row("agent:main:unwatched", { id: "online" }, 30),
        ],
        presenceViewers: [
          {
            id: "online",
            identity: { type: "profile", id: "online" },
            email: "online@example.test",
            watchedSessions: ["agent:main:first", "agent:main:second", "missing"],
            entries: [
              {
                host: "Alice's Mac",
                platform: "Win32",
                deviceFamily: "Mac16,6",
                ip: "203.0.113.7",
                timeZone: "Europe/Vienna",
                lastInputSeconds: 30,
                ts: 10,
              },
              { host: "Alice's phone", ts: 20 },
            ],
          },
        ],
      });
      if (!hasFacet) {
        input.result!.people = [];
      }
      show(input);
      const identity = container.querySelector('[data-activity-identity="online"]');
      // A sparse online identity wins as a whole, without borrowing the facet's label.
      expect(identity?.querySelector("h2")?.textContent).toBe("online@example.test");
      expect(identity?.textContent).toContain("Online");
      expect(
        [...container.querySelectorAll(".activity-feed__connection strong")].map((device) =>
          device.textContent?.trim(),
        ),
      ).toEqual(["Mac16,6 · Windows", "Alice's phone"]);
      const device = identity?.querySelector(".activity-feed__connection")?.textContent;
      expect(device).toContain("203.0.113.7");
      expect(device).toContain("Europe/Vienna");
      expect(
        [...container.querySelectorAll(".activity-feed__viewing-list [data-activity-session]")].map(
          (session) => session.getAttribute("data-activity-session"),
        ),
      ).toEqual(["agent:main:second", "agent:main:first"]);
    },
  );

  it.each(["offline", "Offline"])(
    "resolves the selected %s identity only from an exact server profile facet",
    (personId) => {
      const input = props({
        filters: { personId, query: "", time: "7d" },
        rows: [
          row("Visible session", { id: personId, label: "Row actor" }, 10, {
            participants: [{ identity: { type: "profile", id: personId }, label: "Preview actor" }],
          }),
        ],
      });
      show({ ...input, result: undefined, loading: true });
      expect(container.querySelector(".activity-feed__not-found")).toBeNull();
      expect(
        container.querySelector('.activity-feed__loading [role="status"]')?.textContent,
      ).toContain("Loading");

      show(input);
      if (personId === "offline") {
        const identity = container.querySelector('[data-activity-identity="offline"]');
        expect(identity?.querySelector("h2")?.textContent).toBe("Offline person");
        expect(identity?.textContent).toContain("Offline");
        expect(identity?.querySelector(".activity-feed__viewing-list")).toBeNull();
      } else {
        expect(container.querySelector(".activity-feed__not-found")).not.toBeNull();
        expect(container.querySelector("[data-activity-identity]")).toBeNull();
        expect(container.querySelector("[data-activity-session]")).toBeNull();
      }
    },
  );

  it.each([true, false])(
    "never joins raw presence into a profile Activity page (profile online: %s)",
    (online) => {
      const input = props({
        filters: { personId: "online", query: "", time: "7d" },
        rows: [row("raw-watch", { id: "online" }, 10)],
        presenceViewers: [
          ...(online
            ? [
                {
                  id: "online",
                  identity: { type: "profile" as const, id: "online" },
                  name: "Profile person",
                  watchedSessions: [],
                  entries: [{ host: "Profile device", ts: 1 }],
                },
              ]
            : []),
          {
            id: "online",
            name: "Raw collider",
            watchedSessions: ["raw-watch"],
            entries: [{ host: "Raw device", ts: 1 }],
          },
        ],
      });
      show(input);
      const identity = container.querySelector("[data-activity-identity]")!;
      expect(identity.querySelector("h2")?.textContent).toBe(
        online ? "Profile person" : "Online person",
      );
      expect(identity.textContent).not.toContain("Raw device");
      expect(identity.querySelector(".activity-feed__viewing-list")).toBeNull();
      expect(
        container.querySelectorAll(".activity-feed__people-row .activity-feed__presence-dot"),
      ).toHaveLength(online ? 1 : 0);
    },
  );

  it("selecting Everyone clears the person while preserving the other filters", () => {
    const onFiltersChange = vi.fn();
    show({
      filters: { personId: "online", query: "release", time: "30d" },
      rows: [row("Release session", { id: "online", label: "Online person" }, Date.now())],
      onFiltersChange,
    });

    container.querySelector<HTMLButtonElement>('[data-activity-person=""]')?.click();

    expect(onFiltersChange).toHaveBeenCalledWith({
      personId: null,
      query: "release",
      time: "30d",
    });
  });
});

describe("session activity automation grouping", () => {
  it("groups bound automation separately from cron provenance and bypasses grouping for filters", () => {
    const current = new Date();
    const now = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      12,
    ).getTime();
    const owner = { id: "owner", label: "Owner" };
    const regular = row("Scheduled report", owner, now, { createdVia: "cron" });
    const automationOne = row("Automation one", owner, now - 1_000, { hasAutomation: true });
    const automationTwo = row("Automation two", owner, now - 2_000, { hasAutomation: true });
    const onAutomationDayToggle = vi.fn();

    show({ rows: [regular, automationOne, automationTwo], onAutomationDayToggle });

    const group = container.querySelector<HTMLButtonElement>("[data-activity-automation-group]");
    expect(group?.textContent).toContain("2 automation sessions");
    expect(group?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(1);
    const dayKey = group?.dataset.activityAutomationGroup;
    expect(dayKey).toBeTruthy();
    group?.click();
    expect(onAutomationDayToggle).toHaveBeenCalledWith(dayKey);

    show({
      rows: [regular, automationOne, automationTwo],
      expandedAutomationDays: new Set([dayKey!]),
    });
    expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(3);
    expect(
      container
        .querySelector(
          '[data-activity-session="Scheduled report"] [data-activity-created-via="cron"]',
        )
        ?.textContent?.trim(),
    ).toContain("Automation");
    expect(
      container.querySelector(
        '[data-activity-session="Automation one"] [data-activity-created-via]',
      ),
    ).toBeNull();

    show({ rows: [regular, automationOne] });
    expect(container.querySelector("[data-activity-automation-group]")).toBeNull();
    expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(2);

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
      expect(container.querySelector("[data-activity-automation-group]")).toBeNull();
      expect(container.querySelectorAll("[data-activity-session]")).toHaveLength(2);
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
    const active = container.querySelector('[data-activity-session="Digest run"]')!;
    expect(active.querySelector(".activity-feed__run-dot")).not.toBeNull();
    expect(active.querySelector(".activity-feed__session-headline")?.textContent?.trim()).toBe(
      "Waiting on a fake approval",
    );
    expect(
      active.querySelector(".activity-feed__session-headline")?.getAttribute("data-health"),
    ).toBe("waiting-on-user");
    expect(active.textContent).toContain("Owner");
    for (const key of ["Stale digest", "Active run fallback", "Inactive run"]) {
      expect(
        container.querySelector(
          `[data-activity-session="${key}"] .activity-feed__session-headline`,
        ),
      ).toBeNull();
    }
    expect(
      container.querySelector('[data-activity-session="Inactive run"] .activity-feed__run-dot'),
    ).toBeNull();
  });
});
