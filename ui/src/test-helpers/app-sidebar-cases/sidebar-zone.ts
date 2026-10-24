import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiNavigationItem } from "../../../../src/plugin-sdk/control-ui.js";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { selectSidebarView } from "../app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { createDataTransferStub } from "../drag-data.ts";
import { mountSolid } from "../mount-solid.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";
import { click, rowLink, selectedRowKeys } from "./multi-select-support.ts";

const sessionKeys = ["agent:main:main", "agent:main:alpha", "agent:main:beta"];

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer, clientY: 0 });
  target.dispatchEvent(event);
}

function zoneEntry(sidebar: SidebarLifecycleState, entry: string): HTMLElement {
  return sidebar.querySelector<HTMLElement>(`[data-sidebar-entry="${entry}"]`)!;
}

function pluginEntry(sidebar: SidebarLifecycleState, id: string, area = "pages") {
  return sidebar.querySelector<HTMLElement>(`.sidebar-${area} [data-sidebar-entry="plugin:${id}"]`);
}

function entryOrder(sidebar: Element, selector: string) {
  return Array.from(
    domProbe(sidebar).all<HTMLElement>(selector),
    (row) => row.dataset.sidebarEntry,
  );
}

function drag(source: Element, target: Element) {
  const transfer = createDataTransferStub();
  dispatchDragEvent(source, "dragstart", transfer);
  dispatchDragEvent(target, "dragover", transfer);
  dispatchDragEvent(target, "drop", transfer);
}

function patchAlpha(result: SessionsListResult, patch: Partial<GatewaySessionRow>) {
  const sessions = result.sessions.map((row) =>
    row.key === "agent:main:alpha" ? Object.assign({}, row, patch) : row,
  );
  return { ...result, sessions };
}

async function mountZone(keys = sessionKeys, patch: (row: GatewaySessionRow) => void = () => {}) {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const sessions = createSessionsHarness("main", keys);
  sessions.sessions.state.result!.sessions.forEach(patch);
  const { sidebar, context } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.connected = true;
  const pinAlpha = () => {
    sessions.publish({ result: patchAlpha(sessions.sessions.state.result!, { pinned: true }) });
  };
  return { gateway, sidebar, sessions, context, pinAlpha, dom: domProbe(sidebar) };
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
  sidebar.invalidate();
  return openPage;
}

it("badges pinned attention just like ordinary rows", async () => {
  const keys = ["agent:main:main", "agent:main:page", "agent:main:plain"];
  const { sidebar } = await mountZone(keys, (row) => {
    if (row.key !== "agent:main:main") {
      Object.assign(row, {
        pinned: row.key === "agent:main:page",
        unread: true,
        status: "failed",
        lastRunError: "boom",
        updatedAt: 10,
      });
    }
  });

  for (const key of ["agent:main:page", "agent:main:plain"]) {
    const row = sidebar.querySelector(`[data-session-key="${key}"]`)!;
    const glyph = domProbe(row.querySelector(".sidebar-session-indicator .session-glyph")!);
    expect(glyph.present(".sidebar-session-attention__icon")).toEqual([true]);
    expect(
      glyph.all('.session-glyph__badge--unread[role="img"][aria-label="Unread"]'),
    ).toHaveLength(1);
    const states = domProbe(row).present(".session-row-state", ".nav-item__state");
    expect(states).toEqual([false, false]);
  }
});

it.each([
  { slug: undefined, href: "/plugin?plugin=logbook&id=logbook" },
  { slug: "reports", href: "/reports" },
])("renders plugin tabs as sidebar entries at $href", async ({ slug, href }) => {
  const { gateway, sidebar } = await mountZone(["agent:main:main"]);
  const navigate = vi.fn();
  sidebar.onNavigate = navigate;

  const hello = {
    type: "hello-ok" as const,
    protocol: 1,
    auth: { role: "operator" as const, scopes: ["operator.read"] },
    controlUiTabs: [
      { group: "control" as const, id: "logbook", label: "Logbook", pluginId: "logbook", slug },
    ],
  };
  gateway.publish({ hello });
  sidebar.sidebarEntries = ["route:cron"];
  await selectSidebarView(sidebar, "pages");

  const plugin = () => pluginEntry(sidebar, "logbook/logbook");
  const source = plugin()!;
  const entry = source.querySelector<HTMLAnchorElement>(":scope > .nav-item");
  expect(entry?.textContent).toContain("Logbook");
  expect(entry?.getAttribute("href")).toBe(href);
  expect(source.draggable).toBe(true);
  const onUpdate = vi.fn((entries: string[]) => {
    sidebar.sidebarEntries = entries;
  });
  sidebar.onUpdateSidebarEntries = onUpdate;
  const target = zoneEntry(sidebar, "route:cron");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 200, 30));
  drag(source, target);
  await sidebar.updateComplete;
  expect(onUpdate).toHaveBeenCalled();
  const ordered = entryOrder(sidebar, ".sidebar-rail [data-sidebar-entry]");
  expect(ordered.indexOf("plugin:logbook/logbook")).toBeLessThan(ordered.indexOf("route:cron"));
  zoneEntry(sidebar, "plugin:logbook/logbook").querySelector<HTMLAnchorElement>("a")?.click();
  const location = new URL(href, window.location.origin);
  expect(navigate).toHaveBeenCalledWith("plugin", {
    pathname: location.pathname,
    search: location.search,
    hash: "",
  });

  gateway.publish({ hello: { ...hello, controlUiTabs: [] } });
  await sidebar.updateComplete;
  expect(plugin()).toBeNull();
  expect(pluginEntry(sidebar, "logbook/logbook", "rail")?.querySelector("a") ?? null).toBeNull();
});

it("keeps Pages flat and rail pins independently ordered", async () => {
  const stylesheet = document.createElement("style");
  stylesheet.textContent = ["sidebar-reorder", "sidebar-rail"]
    .map((name) => readStyleSheet(`ui/src/styles/${name}.css`))
    .join("\n");
  document.head.append(stylesheet);
  const originalLocation = window.location.href;
  onTestFinished(() => {
    stylesheet.remove();
    window.history.replaceState(null, "", originalLocation);
  });
  window.history.replaceState(null, "", "/plugin?plugin=example&id=notes");
  const { sidebar, context, dom } = await mountZone();
  const ids = ["boards", "review", "notes"];
  const openPage = pluginNavigation(context, sidebar, ids, false, (id) =>
    id === "boards" ? {} : { parent: "boards" },
  );
  const pins = ["plugin:example/boards", "plugin:example/notes", "route:usage"];
  sidebar.sidebarEntries = [...pins];
  await selectSidebarView(sidebar, "pages");
  const pages = domProbe(dom.query(".sidebar-pages")!);
  const entries = [...pages.all<HTMLElement>('[data-sidebar-entry^="plugin:example/"]')];
  const settled = (entry: Element) =>
    entry.querySelector<SolidBridgeElement<object>>("openclaw-plugin-contributions")!
      .updateComplete;
  await Promise.all(entries.map(settled));
  expect(entries.map((entry) => entry.dataset.sidebarEntry)).toEqual(
    ids.map((id) => `plugin:example/${id}`),
  );
  expect(
    entries.flatMap((entry) =>
      [...entry.querySelectorAll("a")].map((link) => link.getAttribute("href")),
    ),
  ).toEqual(ids.map((id) => `/plugin?plugin=example&id=${id}`));
  expect(pages.all(".nav-item-group, .nav-item__children, .nav-item--child")).toHaveLength(0);
  expect(pages.all('[aria-current="page"]')).toHaveLength(1);
  const selected = entries[2]!.querySelector<HTMLAnchorElement>('a[aria-current="page"]')!;
  expect(selected.getAttribute("aria-label")).toBe("notes");
  expect(selected.classList.contains("nav-item--active")).toBe(true);
  selected.click();
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ id: "notes" });
  for (const entry of entries) {
    const row = entry.closest<HTMLElement>(".sidebar-pages__entry")!;
    const pin = row.querySelector<HTMLButtonElement>(".sidebar-pages__pin")!;
    expect(row.firstElementChild).toBe(entry);
    expect(entry.nextElementSibling).toBe(pin);
    expect(getComputedStyle(row)).toMatchObject({ display: "flex", alignItems: "center" });
    expect(getComputedStyle(entry)).toMatchObject({ display: "flex", flexGrow: "1" });
    expect(getComputedStyle(pin)).toMatchObject({ flexShrink: "0", flexBasis: "28px" });
  }
  for (const id of ["boards", "notes"]) {
    const railEntry = pluginEntry(sidebar, `example/${id}`, "rail")!;
    await settled(railEntry);
    const rail = domProbe(railEntry);
    expect(rail.all("a")).toHaveLength(1);
    expect(rail.attr("a", "aria-label")).toBe(id);
    expect(rail.present(".nav-item__children")).toEqual([false]);
  }
  expect(entryOrder(sidebar, ".sidebar-rail__pin")).toEqual(sidebar.sidebarEntries);
  expect(sidebar.sidebarEntries).toEqual(pins);
});

it("shows emoji destination icons in Pages and in pinned rail entries", async () => {
  const { sidebar, context } = await mountZone();
  pluginNavigation(context, sidebar, ["planning", "notes"], false, (id) => ({
    parent: "boards",
    icon: id === "planning" ? "⏰" : "toString",
  }));
  sidebar.sidebarEntries = ["plugin:example/planning"];
  await selectSidebarView(sidebar, "pages");
  const pages = sidebar.querySelector(
    '.sidebar-pages [data-sidebar-entry="plugin:example/planning"] .nav-item__icon',
  );
  const rail = sidebar.querySelector(
    '.sidebar-rail [data-sidebar-entry="plugin:example/planning"] .nav-item__icon',
  );
  for (const icon of [pages, rail]) {
    expect(icon?.querySelector(".session-glyph__emoji")?.textContent).toBe("⏰");
    expect(icon?.querySelector("svg")).toBeNull();
  }
  // Arbitrary text that is not an appearance keeps the fallback icon.
  const notes = sidebar.querySelector(
    '.sidebar-pages [data-sidebar-entry="plugin:example/notes"] .nav-item__icon',
  );
  expect(notes?.querySelector(".session-glyph__emoji")).toBeNull();
  expect(notes?.querySelector("svg")).not.toBeNull();
});

it("keeps child icons and explicit unpins across registration", async () => {
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
  for (const id of ["review", "notes"]) {
    const expectedIcon = id === "review" ? "activity" : "plug";
    const icon = mountSolid(() => createComponent(Icon, { name: expectedIcon })).container;
    const paths = pluginEntry(sidebar, `example/${id}`)!.querySelectorAll(
      ".nav-item__icon svg path",
    );
    expect([...paths].map((path) => path.getAttribute("d"))).toEqual(
      [...icon.querySelectorAll("svg path")].map((path) => path.getAttribute("d")),
    );
  }
  const review = pluginEntry(sidebar, "example/review")!;
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
  expect(pluginEntry(sidebar, "example/review", "rail")).toBeNull();
  expect(pluginEntry(sidebar, "example/review")).not.toBeNull();
});

it("does not pin or insert a promoted child dropped from Threads", async () => {
  const { sidebar, sessions } = await mountZone();
  sessions.publishList({
    result: patchAlpha((await sessions.list())!, { spawnedBy: "agent:main:main" }),
  });
  sidebar.sidebarEntries = ["route:usage", "route:plugins"];
  const onUpdate = vi.fn();
  sidebar.onUpdateSidebarEntries = onUpdate;
  await sidebar.updateComplete;
  const source = sidebar.querySelector('[data-session-key="agent:main:alpha"]')!;
  const target = zoneEntry(sidebar, "route:plugins");
  const dataTransfer = createDataTransferStub();
  for (const type of ["dragstart", "dragover"] as const) {
    dispatchDragEvent(type === "dragstart" ? source : target, type, dataTransfer);
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-rail__pins--drag-active")).toBeNull();
  }
  dispatchDragEvent(target, "drop", dataTransfer);
  await sidebar.updateComplete;
  await vi.dynamicImportSettled();
  expect(sessions.patch).not.toHaveBeenCalled();
  expect(onUpdate).not.toHaveBeenCalled();
  expect(sidebar.sessionOrganizer.draggingSessionKey).toBeNull();
});

it("unpins personal plugin shortcuts even when defaultVisible is true", async () => {
  const { sidebar, context } = await mountZone();
  pluginNavigation(context, sidebar, ["review"], true);
  sidebar.sidebarEntries = ["plugin:example/review", "route:usage"];
  const onUpdate = vi.fn();
  sidebar.onUpdateSidebarEntries = onUpdate;
  await sidebar.updateComplete;
  const source = zoneEntry(sidebar, "plugin:example/review");
  const target = sidebar.querySelector('[data-session-section="ungrouped"]')!;
  drag(source, target);

  expect(onUpdate).toHaveBeenCalledWith(["route:usage"]);
});

it("unpins one session without pruning unknown-agent slots", async () => {
  const { sidebar, sessions, pinAlpha, dom } = await mountZone();
  pinAlpha();
  sidebar.sidebarEntries = ["session:agent:b:remote", "session:agent:main:alpha", "route:usage"];
  const onUpdate = vi.fn();
  sidebar.onUpdateSidebarEntries = onUpdate;
  await sidebar.updateComplete;

  const unresolved = sidebar.querySelector('[data-sidebar-entry="session:agent:b:remote"]');
  expect(unresolved).toBeNull();

  const alpha = dom.query('[data-session-key="agent:main:alpha"]')!;
  alpha.querySelector<HTMLButtonElement>('[data-sidebar-session-pin="true"]')?.click();
  await waitForFast(() =>
    expect(onUpdate).toHaveBeenCalledWith(["session:agent:b:remote", "route:usage"]),
  );
  expect(sessions.patch).not.toHaveBeenCalled();
});

it("keeps pinned rows first in shift-range selection order", async () => {
  const { sidebar, pinAlpha } = await mountZone();
  pinAlpha();
  sidebar.sidebarEntries = ["session:agent:main:alpha", "route:usage"];
  await sidebar.updateComplete;
  click(rowLink(sidebar, "agent:main:alpha"), { altKey: true });
  click(rowLink(sidebar, "agent:main:beta"), { shiftKey: true });
  await sidebar.updateComplete;

  expect(selectedRowKeys(sidebar)).toEqual(sessionKeys.slice(1));
});
