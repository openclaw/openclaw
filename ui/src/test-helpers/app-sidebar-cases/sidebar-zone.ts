import { render, type LitElement } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiNavigationItem } from "../../../../src/plugin-sdk/control-ui.js";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { selectSidebarView } from "../app-sidebar-setup.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { createDataTransferStub } from "../drag-data.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";
import "../../plugins/control-ui-view.runtime.ts";

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
  clientY = 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
}

function zoneEntry(sidebar: SidebarLifecycleState, entry: string): HTMLElement {
  const element = sidebar.querySelector<HTMLElement>(`[data-sidebar-entry="${entry}"]`);
  if (!element) {
    throw new Error(`expected sidebar zone entry ${entry}`);
  }
  return element;
}

async function mountZone() {
  const gateway = createGateway({} as GatewayBrowserClient);
  const sessions = createSessionsHarness("main", [
    "agent:main:main",
    "agent:main:alpha",
    "agent:main:beta",
  ]);
  const { sidebar, context } = await mountSidebar(gateway, sessions.sessions);
  sidebar.connected = true;
  return { sidebar, sessions, context };
}

function pluginNavigation(
  context: import("../../app/context.ts").ApplicationContext,
  sidebar: SidebarLifecycleState,
  ids: string[],
  defaultVisible = false,
  presentation: (id: string) => Pick<ControlUiNavigationItem, "parent" | "icon"> = () => ({}),
) {
  const openPage = vi.fn();
  const signal = new AbortController().signal;
  const entries = ids.map((id) => ({
    key: `example/${id}`,
    pluginId: "example",
    signal,
    value: { id, label: id, defaultVisible, page: { id }, ...presentation(id) },
    host: { navigation: { pageHref: () => `/plugin?plugin=example&id=${id}`, openPage } },
  }));
  Object.assign(context, {
    plugins: {
      registrations: (kind: string) => (kind === "navigation" ? entries : []),
      selectedReplacement: () => undefined,
      subscribe: () => () => {},
    },
  });
  sidebar.requestUpdate();
  return openPage;
}

describe("AppSidebar interleaved zone", () => {
  it("keeps personal rail pins outside the session-list page budget", async () => {
    const keys = [
      "agent:main:session-0",
      ...Array.from({ length: 40 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    for (const row of result.sessions.slice(0, 31)) {
      row.pinned = true;
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    sidebar.sidebarEntries = keys.slice(0, 31).map((key) => `session:${key}`);
    await sidebar.updateComplete;
    expect(sidebar.querySelectorAll(".sidebar-rail__pin")).toHaveLength(31);
    expect(
      sidebar.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
    ).toHaveLength(10);
    expect(sidebar.querySelector(".sidebar-session-pagination")).not.toBeNull();
  });

  it("keeps a pinned session visible outside the first-page budget", async () => {
    const pinnedKey = "agent:main:pinned";
    const keys = [
      ...Array.from({ length: 10 }, (_, index) => `agent:main:session-${index + 1}`),
      pinnedKey,
      "agent:main:extra",
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    const pinned = result.sessions.find((row) => row.key === pinnedKey);
    expect(pinned).toBeDefined();
    if (!pinned) {
      return;
    }
    pinned.pinned = true;
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    sidebar.sidebarEntries = [`session:${pinnedKey}`];
    await sidebar.updateComplete;
    expect(
      sidebar.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
    ).toHaveLength(10);
    expect(
      sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="session:${pinnedKey}"] a`),
    ).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:session-10"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:extra"]')).toBeNull();
  });

  it("leads a pinned row with activity like any other session row", async () => {
    const keys = ["agent:main:main", "agent:main:page", "agent:main:plain"];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    for (const row of result.sessions) {
      if (row.key === "agent:main:page") {
        Object.assign(row, { pinned: true, hasActiveRun: true, unread: true });
      }
      if (row.key === "agent:main:plain") {
        Object.assign(row, { hasActiveRun: true, unread: true });
      }
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    // Pinning is not a status, so it must not claim the row's one leading slot.
    const row = sidebar.querySelector('[data-session-key="agent:main:page"]');
    const plain = sidebar.querySelector('[data-session-key="agent:main:plain"]');
    expect(row?.querySelector(".sidebar-session-indicator")?.innerHTML).toBe(
      plain?.querySelector(".sidebar-session-indicator")?.innerHTML,
    );
    expect(row?.querySelector(".nav-item__state")).toBeNull();
    expect(row?.querySelector(".sidebar-session-indicator .session-glyph__ring")).not.toBeNull();
  });

  it("badges pinned attention just like ordinary rows", async () => {
    const keys = ["agent:main:main", "agent:main:page", "agent:main:plain"];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    for (const row of result.sessions) {
      if (row.key !== "agent:main:main") {
        Object.assign(row, {
          pinned: row.key === "agent:main:page",
          unread: true,
          status: "failed",
          lastRunError: "boom",
          updatedAt: 10,
        });
      }
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    for (const key of ["agent:main:page", "agent:main:plain"]) {
      const row = sidebar.querySelector(`[data-session-key="${key}"]`);
      const glyph = row?.querySelector(".sidebar-session-indicator .session-glyph");
      expect(glyph?.querySelector(".sidebar-session-attention__icon")).not.toBeNull();
      expect(
        glyph?.querySelectorAll('.session-glyph__badge--unread[role="img"][aria-label="Unread"]'),
      ).toHaveLength(1);
      expect(row?.querySelector(".session-row-state")).toBeNull();
      expect(row?.querySelector(".nav-item__state")).toBeNull();
    }
  });

  it("renders routes and pinned sessions in the canonical entry order", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    sessions.publish({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:alpha"
            ? Object.assign({}, row, { label: "Alpha", pinned: true })
            : row,
        ),
      },
    });
    sidebar.sidebarEntries = ["route:usage", "session:agent:main:alpha", "route:plugins"];
    await sidebar.updateComplete;

    const labels = [...sidebar.querySelectorAll<HTMLElement>(".sidebar-rail__pin")].map(
      (entry) =>
        entry.querySelector("a")?.getAttribute("aria-label") ??
        entry.querySelector(".nav-item__text")?.textContent?.trim(),
    );
    expect(labels).toEqual(["Usage", "Alpha", "Plugins"]);
    expect(sidebar.querySelector('[data-session-section="pinned"]')).toBeNull();
    const pinnedLink = sidebar.querySelector(
      '.sidebar-rail [data-sidebar-entry="session:agent:main:alpha"] a',
    );
    expect(pinnedLink?.hasAttribute("role")).toBe(false);
    expect(pinnedLink?.closest('[role="list"]')).toBeNull();
    expect(sidebar.querySelector(".sidebar-footer-bar__home")?.hasAttribute("draggable")).toBe(
      false,
    );
  });

  it.each([
    { slug: undefined, href: "/plugin?plugin=logbook&id=logbook" },
    { slug: "reports", href: "/reports" },
  ])("renders plugin tabs as sidebar entries at $href", async ({ slug, href }) => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;

    gateway.publish({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.read"] },
        controlUiTabs: [
          { group: "control", id: "logbook", label: "Logbook", pluginId: "logbook", slug },
        ],
      },
    });
    sidebar.sidebarEntries = ["route:cron"];
    await selectSidebarView(sidebar, "pages");

    const entry = sidebar.querySelector<HTMLAnchorElement>(
      '.sidebar-pages [data-sidebar-entry="plugin:logbook/logbook"] > .nav-item',
    );
    expect(entry?.textContent).toContain("Logbook");
    expect(entry?.getAttribute("href")).toBe(href);
    const pluginEntry = sidebar.querySelector<HTMLElement>(
      '.sidebar-pages [data-sidebar-entry="plugin:logbook/logbook"]',
    )!;
    expect(pluginEntry.draggable).toBe(true);
    const onUpdate = vi.fn((entries: string[]) => {
      sidebar.sidebarEntries = entries;
    });
    sidebar.onUpdateSidebarEntries = onUpdate;
    const target = zoneEntry(sidebar, "route:cron");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 200, 30));
    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(pluginEntry, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer);
    dispatchDragEvent(target, "drop", dataTransfer);
    await sidebar.updateComplete;
    expect(onUpdate).toHaveBeenCalled();
    const ordered = [
      ...sidebar.querySelectorAll<HTMLElement>(".sidebar-rail [data-sidebar-entry]"),
    ].map((row) => row.dataset.sidebarEntry);
    expect(ordered.indexOf("plugin:logbook/logbook")).toBeLessThan(ordered.indexOf("route:cron"));
    zoneEntry(sidebar, "plugin:logbook/logbook").querySelector<HTMLAnchorElement>("a")?.click();
    const location = new URL(href, window.location.origin);
    expect(navigate).toHaveBeenCalledWith("plugin", {
      pathname: location.pathname,
      search: location.search,
      hash: "",
    });

    gateway.publish({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.read"] },
        controlUiTabs: [],
      },
    });
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector('.sidebar-pages [data-sidebar-entry="plugin:logbook/logbook"]'),
    ).toBeNull();
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="plugin:logbook/logbook"] a'),
    ).toBeNull();
  });

  it("reorders default-visible plugin destinations with ordinary pinned pages", async () => {
    const { sidebar, context } = await mountZone();
    pluginNavigation(context, sidebar, ["review", "notes"], true);
    sidebar.sidebarEntries = ["route:usage", "plugin:example/review", "plugin:example/notes"];
    const onUpdate = vi.fn((entries: string[]) => {
      sidebar.sidebarEntries = entries;
    });
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = zoneEntry(sidebar, "plugin:example/review");
    expect(source.draggable).toBe(true);
    const target = zoneEntry(sidebar, "route:usage");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 200, 30));
    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer);
    dispatchDragEvent(target, "drop", dataTransfer);
    await sidebar.updateComplete;
    expect(onUpdate).toHaveBeenLastCalledWith([
      "plugin:example/review",
      "route:usage",
      "plugin:example/notes",
    ]);
    expect(
      [...sidebar.querySelectorAll<HTMLElement>("[data-sidebar-entry]")].map(
        (row) => row.dataset.sidebarEntry,
      ),
    ).toEqual(sidebar.sidebarEntries);
    pluginNavigation(context, sidebar, []);
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="plugin:example/review"] a'),
    ).toBeNull();
    pluginNavigation(context, sidebar, ["notes", "review"], true);
    await sidebar.updateComplete;
    expect(
      [...sidebar.querySelectorAll<HTMLElement>("[data-sidebar-entry]")].map(
        (row) => row.dataset.sidebarEntry,
      ),
    ).toEqual(sidebar.sidebarEntries);
  });

  it("renders a pinned native plugin destination and dispatches its owned navigation", async () => {
    const { sidebar, context } = await mountZone();
    const openPage = pluginNavigation(context, sidebar, ["review"]);
    sidebar.sidebarEntries = ["plugin:example/review"];
    await sidebar.updateComplete;
    await waitForFast(() =>
      expect(
        sidebar.querySelector('[data-sidebar-entry="plugin:example/review"] a'),
      ).not.toBeNull(),
    );
    const link = zoneEntry(sidebar, "plugin:example/review").querySelector<HTMLAnchorElement>("a");
    expect(link?.getAttribute("href")).toBe("/plugin?plugin=example&id=review");
    link?.click();
    expect(openPage).toHaveBeenCalledWith({ id: "review" });
  });

  it("keeps plugin destinations flat in Pages and separate from ordered rail pins", async () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = [
      readStyleSheet("ui/src/styles/sidebar-reorder.css"),
      readStyleSheet("ui/src/styles/sidebar-rail.css"),
    ].join("\n");
    document.head.append(stylesheet);
    const originalLocation = window.location.href;
    onTestFinished(() => {
      stylesheet.remove();
      window.history.replaceState(null, "", originalLocation);
    });
    window.history.replaceState(null, "", "/plugin?plugin=example&id=notes");
    const { sidebar, context } = await mountZone();
    const openPage = pluginNavigation(
      context,
      sidebar,
      ["boards", "review", "notes"],
      false,
      (id) => (id === "boards" ? {} : { parent: "boards" }),
    );
    sidebar.sidebarEntries = ["plugin:example/boards", "plugin:example/notes", "route:usage"];
    await selectSidebarView(sidebar, "pages");
    const pages = sidebar.querySelector<HTMLElement>(".sidebar-pages")!;
    const entries = [
      ...pages.querySelectorAll<HTMLElement>('[data-sidebar-entry^="plugin:example/"]'),
    ];
    await Promise.all(
      entries.map(
        (entry) => entry.querySelector<LitElement>("openclaw-plugin-contributions")!.updateComplete,
      ),
    );
    expect(entries.map((entry) => entry.dataset.sidebarEntry)).toEqual([
      "plugin:example/boards",
      "plugin:example/review",
      "plugin:example/notes",
    ]);
    expect(
      entries.flatMap((entry) =>
        [...entry.querySelectorAll("a")].map((link) => link.getAttribute("href")),
      ),
    ).toEqual([
      "/plugin?plugin=example&id=boards",
      "/plugin?plugin=example&id=review",
      "/plugin?plugin=example&id=notes",
    ]);
    expect(
      pages.querySelectorAll(".nav-item-group, .nav-item__children, .nav-item--child"),
    ).toHaveLength(0);
    expect(pages.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const selected = entries[2]!.querySelector<HTMLAnchorElement>('a[aria-current="page"]')!;
    expect(selected.getAttribute("aria-label")).toBe("notes");
    expect(selected.classList.contains("nav-item--active")).toBe(true);
    selected.click();
    expect(openPage).toHaveBeenCalledExactlyOnceWith({ id: "notes" });
    // JSDOM owns structure and CSS contracts; real browser siblings own pixel geometry.
    for (const entry of entries) {
      const row = entry.closest<HTMLElement>(".sidebar-pages__entry")!;
      const pin = row.querySelector<HTMLButtonElement>(".sidebar-pages__pin")!;
      expect(row.firstElementChild).toBe(entry);
      expect(entry.nextElementSibling).toBe(pin);
      expect(getComputedStyle(row).display).toBe("flex");
      expect(getComputedStyle(row).alignItems).toBe("center");
      expect(getComputedStyle(entry).display).toBe("flex");
      expect(getComputedStyle(entry).flexGrow).toBe("1");
      expect(getComputedStyle(pin).flexShrink).toBe("0");
      expect(getComputedStyle(pin).flexBasis).toBe("28px");
      expect(entry.querySelector(".sidebar-reorder-menu")).toBeNull();
    }
    // Pinned references remain separate icon controls.
    for (const id of ["boards", "notes"]) {
      const railEntry = sidebar.querySelector<HTMLElement>(
        `.sidebar-rail [data-sidebar-entry="plugin:example/${id}"]`,
      )!;
      await railEntry.querySelector<LitElement>("openclaw-plugin-contributions")!.updateComplete;
      expect(railEntry.querySelectorAll("a")).toHaveLength(1);
      expect(railEntry.querySelector(".nav-item__children")).toBeNull();
      expect(railEntry.querySelector("a")?.getAttribute("aria-label")).toBe(id);
      expect(railEntry.querySelector(".sidebar-reorder-trigger")).toBeNull();
    }
    expect(
      [...sidebar.querySelectorAll<HTMLElement>(".sidebar-rail__pin")].map(
        (entry) => entry.dataset.sidebarEntry,
      ),
    ).toEqual(sidebar.sidebarEntries);
    expect(sidebar.sidebarEntries).toEqual([
      "plugin:example/boards",
      "plugin:example/notes",
      "route:usage",
    ]);
  });

  it("retains an unavailable plugin reference without exposing its former destination", async () => {
    const { sidebar, context } = await mountZone();
    pluginNavigation(context, sidebar, []);
    sidebar.sidebarEntries = ["plugin:example/review", "route:usage"];
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="plugin:example/review"]'),
    ).toBeNull();
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="plugin:example/review"] a'),
    ).toBeNull();
    expect(sidebar.sidebarEntries).toEqual(["plugin:example/review", "route:usage"]);
  });

  it("offers child destinations with their icons and preserves an explicit removal", async () => {
    const { sidebar, context } = await mountZone();
    const register = () =>
      pluginNavigation(context, sidebar, ["review", "notes"], false, (id) => ({
        parent: "boards",
        icon: id === "review" ? "activity" : "toString",
      }));
    register();
    sidebar.sidebarEntries = ["route:usage", "plugin:example/review"];
    sidebar.onUpdateSidebarEntries = (entries) => {
      sidebar.sidebarEntries = entries;
    };
    await selectSidebarView(sidebar, "pages");
    const icon = document.createElement("div");
    for (const [id, expectedIcon] of [
      ["review", "activity"],
      ["notes", "plug"],
    ] as const) {
      render(icons[expectedIcon], icon);
      expect(
        sidebar.querySelector(
          `.sidebar-pages [data-sidebar-entry="plugin:example/${id}"] .nav-item__icon svg`,
        )?.outerHTML,
      ).toBe(icon.querySelector("svg")?.outerHTML);
    }
    const review = sidebar.querySelector(
      '.sidebar-pages [data-sidebar-entry="plugin:example/review"]',
    )!;
    const unpin = review
      .closest(".sidebar-pages__entry")!
      .querySelector<HTMLButtonElement>('[aria-label="Unpin"]')!;
    expect(unpin).not.toBeNull();
    unpin.click();
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    register();
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="plugin:example/review"]'),
    ).toBeNull();
    expect(
      sidebar.querySelector('.sidebar-pages [data-sidebar-entry="plugin:example/review"]'),
    ).not.toBeNull();
  });

  it("writes reordered entries after a route drop", async () => {
    const { sidebar } = await mountZone();
    sidebar.sidebarEntries = ["route:usage", "route:plugins", "route:cron"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = zoneEntry(sidebar, "route:cron");
    const target = zoneEntry(sidebar, "route:usage");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 10,
      height: 20,
    } as DOMRect);
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer, 11);
    dispatchDragEvent(target, "drop", dataTransfer, 11);

    expect(onUpdate).toHaveBeenCalledWith(["route:cron", "route:usage", "route:plugins"]);
  });

  it("pins and inserts a session dropped from Threads", async () => {
    const { sidebar, sessions } = await mountZone();
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = sidebar.querySelector('[data-session-key="agent:main:alpha"]');
    const target = zoneEntry(sidebar, "route:plugins");
    if (!source) {
      throw new Error("expected Alpha session row");
    }
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 10,
      height: 20,
    } as DOMRect);
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer, 11);
    dispatchDragEvent(target, "drop", dataTransfer, 11);

    expect(sessions.patch).not.toHaveBeenCalled();
    // A personal reference write does not mutate or wait for shared session state.
    await waitForFast(() =>
      expect(onUpdate).toHaveBeenCalledWith([
        "route:usage",
        "session:agent:main:alpha",
        "route:plugins",
      ]),
    );
  });

  it("does not pin or insert a promoted child dropped from Threads", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = await sessions.list();
    if (!result) {
      throw new Error("expected a session list result");
    }
    const alpha = result.sessions.find((row) => row.key === "agent:main:alpha");
    if (!alpha) {
      throw new Error("expected the alpha session row");
    }
    const promoted = { ...alpha, spawnedBy: "agent:main:main" };
    sessions.publishList({
      result: {
        ...result,
        sessions: result.sessions.map((row) => (row === alpha ? promoted : row)),
      },
    });
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = sidebar.querySelector('[data-session-key="agent:main:alpha"]');
    if (!source) {
      throw new Error("expected promoted child session row");
    }
    const target = zoneEntry(sidebar, "route:plugins");
    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(source, "dragstart", dataTransfer);
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-rail__pins--drag-active")).toBeNull();
    dispatchDragEvent(target, "dragover", dataTransfer);
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-rail__pins--drag-active")).toBeNull();
    dispatchDragEvent(target, "drop", dataTransfer);
    await sidebar.updateComplete;
    await vi.dynamicImportSettled();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(sidebar.sessionOrganizer.draggingSessionKey).toBeNull();
  });

  it("hides a route dropped into the session-list region", async () => {
    const { sidebar } = await mountZone();
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = zoneEntry(sidebar, "route:usage");
    const target = sidebar.querySelector('[data-session-section="ungrouped"]');
    if (!target) {
      throw new Error("expected session-list region");
    }
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer);
    dispatchDragEvent(target, "drop", dataTransfer);

    expect(onUpdate).toHaveBeenCalledWith(["route:plugins"]);
  });

  it.each([false, true])(
    "unpins personal plugin shortcuts regardless of catalog defaults (defaultVisible: %s)",
    async (defaultVisible) => {
      const { sidebar, context } = await mountZone();
      pluginNavigation(context, sidebar, ["review"], defaultVisible);
      sidebar.sidebarEntries = ["plugin:example/review", "route:usage"];
      const onUpdate = vi.fn();
      sidebar.onUpdateSidebarEntries = onUpdate;
      await sidebar.updateComplete;
      const source = zoneEntry(sidebar, "plugin:example/review");
      const target = sidebar.querySelector('[data-session-section="ungrouped"]');
      if (!target) {
        throw new Error("expected session-list region");
      }
      const dataTransfer = createDataTransferStub();

      dispatchDragEvent(source, "dragstart", dataTransfer);
      dispatchDragEvent(target, "dragover", dataTransfer);
      dispatchDragEvent(target, "drop", dataTransfer);

      expect(onUpdate).toHaveBeenCalledWith(["route:usage"]);
    },
  );

  it("prunes only the unpinned session's entry and preserves unknown-agent slots", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    sessions.publish({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:alpha" ? Object.assign({}, row, { pinned: true }) : row,
        ),
      },
    });
    sidebar.sidebarEntries = ["session:agent:b:remote", "session:agent:main:alpha", "route:usage"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;

    const unresolved = sidebar.querySelector('[data-sidebar-entry="session:agent:b:remote"]');
    expect(unresolved).toBeNull();

    sidebar
      .querySelector<HTMLButtonElement>(
        '[data-session-key="agent:main:alpha"] [data-sidebar-session-pin="true"]',
      )
      ?.click();
    await waitForFast(() =>
      expect(onUpdate).toHaveBeenCalledWith(["session:agent:b:remote", "route:usage"]),
    );
    expect(sessions.patch).not.toHaveBeenCalled();
  });

  it("keeps pinned rows first in shift-range selection order", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    sessions.publish({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:alpha" ? Object.assign({}, row, { pinned: true }) : row,
        ),
      },
    });
    sidebar.sidebarEntries = ["session:agent:main:alpha", "route:usage"];
    await sidebar.updateComplete;
    const alpha = sidebar.querySelector(
      '[data-session-key="agent:main:alpha"] .sidebar-recent-session__link',
    );
    const beta = sidebar.querySelector(
      '[data-session-key="agent:main:beta"] .sidebar-recent-session__link',
    );
    if (!alpha || !beta) {
      throw new Error("expected session links");
    }

    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    beta.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    await sidebar.updateComplete;

    expect(
      [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session--selected")].map(
        (row) => row.dataset.sessionKey,
      ),
    ).toEqual(["agent:main:alpha", "agent:main:beta"]);
  });
});
