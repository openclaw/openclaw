/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import * as toast from "../lib/toast.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { domProbe } from "../test-helpers/dom-probe.ts";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { AppSidebar, getAppSidebarOwner } from "./app-sidebar.tsx";
import { installTitleTooltips } from "./tooltip-title.ts";
import { dispatchMousePointer, settleTooltip } from "./tooltip.test-support.ts";

async function fixture(properties: Partial<Sidebar> = {}, agents?: typeof TWO_AGENTS) {
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
  const mounted = await mountSidebar(gateway.gateway, sessions.sessions, "panel", agents);
  const { sidebar } = mounted;
  sidebar.connected = true;
  sidebar.sidebarEntries = [];
  sidebar.onUpdateSidebarEntries = (entries) => {
    sidebar.sidebarEntries = entries;
  };
  Object.assign(sidebar, properties);
  await sidebar.updateComplete;
  const publishRows = (rows: GatewaySessionRow[]) =>
    sessions.publishList({ agentId: "main", result: { ...result, sessions: rows } });
  const publish = (patch: Partial<GatewaySessionRow>, key = "agent:main:mine") =>
    publishRows(result.sessions.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const append = (patch: Partial<GatewaySessionRow>) =>
    publishRows([...result.sessions, { ...result.sessions[1]!, ...patch }]);
  return { ...mounted, sessions, gateway, result, publish, append, dom: domProbe(sidebar) };
}

type Sidebar = Awaited<ReturnType<typeof mountSidebar>>["sidebar"];
async function click(sidebar: Sidebar, selector: string) {
  sidebar.querySelector<HTMLElement>(selector)!.click();
  await sidebar.updateComplete;
}

function mockMobile(matches: (query: string) => boolean) {
  vi.spyOn(globalThis, "matchMedia").mockImplementation((media) => ({
    media,
    matches: matches(media),
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
}

function rail(sidebar: Sidebar, entry: string) {
  return sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="${entry}"]`);
}
function link(sidebar: Sidebar, entry: string) {
  return rail(sidebar, entry)!.querySelector<HTMLAnchorElement>("a")!;
}
function tooltip() {
  return document.body.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>(
    ":scope > openclaw-tooltip",
  )!;
}
async function openAgentMenu(sidebar: Sidebar) {
  await click(sidebar, ".sidebar-agent-card__main");
  await vi.dynamicImportSettled();
  await sidebar.updateComplete;
}
async function removePin(sidebar: Sidebar) {
  expect(sidebar.querySelector(".sidebar-rail-pin-menu")).not.toBeNull();
  await click(sidebar, '.sidebar-rail-pin-menu [data-value="remove"]');
}

async function update(sidebar: Sidebar, properties: Partial<Sidebar>) {
  Object.assign(sidebar, properties);
  await sidebar.updateComplete;
}
async function seed(sidebar: Sidebar, rows: Parameters<Sidebar["pinnedSessions"]["seed"]>[0]) {
  sidebar.pinnedSessions.seed(rows);
  sidebar.invalidate();
  await sidebar.updateComplete;
}
function cachedPin(key: string, label = "Saved title") {
  return { key, label, pinned: true, isChild: false, children: [] };
}
async function pinLookup(key = "agent:other:unloaded", fallback = false) {
  const base = await fixture();
  const pending = createDeferred<Awaited<ReturnType<typeof base.sessions.sessions.describe>>>();
  const read = vi.spyOn(base.sessions.sessions, "describe").mockReturnValueOnce(pending.promise);
  if (fallback) {
    read.mockResolvedValue({ session: null });
  } else {
    read.mockReturnValue(pending.promise);
  }
  const navigate = vi.fn();
  base.sidebar.onNavigate = navigate;
  return { ...base, key, pending, read, navigate };
}
function outbox(key: string, total = 2) {
  return {
    total,
    attentionCountForSession: (candidate: string) => (candidate === key ? total : 0),
    hasSessionDraft: (candidate: string) => total > 0 && candidate === key,
  };
}
function drag(target: Element, type: string, transfer: ReturnType<typeof createDataTransferStub>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: 0 } });
  target.dispatchEvent(event);
  return event;
}

describe("personal navigation rail", () => {
  it("keeps fixed navigation and Home, Inbox, identity separate from the middle view", async () => {
    const { sidebar, dom } = await fixture();
    expect(
      [...dom.all("[data-navigation-view]")].map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Pages", "Sessions", "Users"]);
    const frame = dom.query("aside.sidebar")!;
    const bottom = dom.query(".sidebar-rail__bottom")!;
    expect(
      domProbe(bottom).present(
        ".sidebar-footer-bar__home",
        "openclaw-sidebar-attention",
        ".sidebar-identity-card",
      ),
    ).toEqual([true, true, true]);
    expect(dom.present(".nav-item--home", ".sidebar-shell__footer .sidebar-identity-card")).toEqual(
      [false, false],
    );
    await click(sidebar, '[data-navigation-view="pages"]');
    expect(dom.query(".sidebar-pages")).not.toBeNull();
    expect(dom.query(".sidebar-session-content")).toBeNull();
    expect(dom.query("aside.sidebar")).toBe(frame);
    expect(dom.query(".sidebar-rail__bottom")).toBe(bottom);
    const identity = bottom.querySelector(".sidebar-identity-card")!;
    expect(
      identity.querySelector(".sidebar-identity-card__avatar .sidebar-identity-card__status"),
    ).not.toBeNull();
    expect(identity.getAttribute("data-connection-status")).toBe("connected");
    expect(identity.getAttribute("aria-label")).toContain("Identity and app menu for Self");
    for (const status of ["connecting", "reconnecting", "offline", "reload-required"] as const) {
      sidebar.connectionStatus = status;
      await sidebar.updateComplete;
      expect(identity.getAttribute("data-connection-status")).toBe(status);
      expect(identity.querySelector(".gateway-status")).toBeNull();
    }
  });

  it("keeps Home outbox attention and drafts visible with its run state when collapsed", async () => {
    const { sidebar, publish, dom } = await fixture();
    publish({ hasActiveRun: true, status: "running" }, "agent:main:main");
    await update(sidebar, { storedOutboxes: outbox("agent:main:main"), navigationCollapsed: true });
    const home = dom.query(".sidebar-footer-bar__home")!;
    const icons = domProbe(home);
    expect(icons.attr(".session-glyph__ring", "aria-label")).toBe("Active run");
    expect(icons.attr(".session-row-badge--attention", "aria-label")).toContain("2");
    expect(icons.present(".session-row-badge--draft")).toEqual([true]);
    await update(sidebar, { storedOutboxes: outbox("agent:main:main", 0) });
    expect(
      icons.present(
        ".session-row-badge--attention",
        ".session-row-badge--draft",
        ".session-glyph__ring",
      ),
    ).toEqual([false, false, true]);
  });

  it("pins and unpins sessions personally without sessions.patch", async () => {
    const { sidebar, sessions, dom } = await fixture();
    const pin = dom.query<HTMLButtonElement>(
      '[data-session-key="agent:main:mine"] [data-sidebar-session-pin]',
    );
    expect(pin).not.toBeNull();
    for (const pinned of [true, false]) {
      sidebar
        .querySelector<HTMLButtonElement>(
          '[data-session-key="agent:main:mine"] [data-sidebar-session-pin]',
        )!
        .click();
      await sidebar.updateComplete;
      expect(sidebar.sidebarEntries).toEqual(pinned ? ["session:agent:main:mine"] : []);
      expect(
        sidebar
          .querySelector('[data-session-key="agent:main:mine"]')
          ?.closest(".session-row-host")
          ?.classList.contains("session-row-host--pinned"),
      ).toBe(pinned);
      if (pinned) {
        expect(rail(sidebar, "session:agent:main:mine")).toBeNull();
        expect(
          sidebar.querySelector(
            '[data-session-section="pinned"] [data-session-key="agent:main:mine"]',
          ),
        ).not.toBeNull();
      }
      expect(sessions.sessions.patch).not.toHaveBeenCalled();
    }
  });

  it("adds a session to an empty rail and shows the drop affordance only during its drag", async () => {
    const { sidebar, sessions, publish, dom } = await fixture();
    publish({ label: "Release Notes" });
    await sidebar.updateComplete;
    const pins = dom.query(".sidebar-rail__pins")!;
    expect(pins.children).toHaveLength(0);
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);
    const unrelated = createDataTransferStub();
    unrelated.setData("text/plain", "not a sidebar item");
    expect(drag(pins, "dragover", unrelated).defaultPrevented).toBe(false);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);

    const source = dom.query('[data-session-key="agent:main:mine"]')!;
    const transfer = createDataTransferStub();
    drag(source, "dragstart", transfer);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(true);
    expect(drag(pins, "dragover", transfer).defaultPrevented).toBe(true);
    drag(pins, "drop", transfer);
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["session-rail:agent:main:mine"]);
    expect(
      pins.querySelector('[aria-label="Release Notes"] .sidebar-rail__monogram')?.textContent,
    ).toBe("RN");
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);
    expect(sessions.sessions.patch).not.toHaveBeenCalled();
    const pin = pins.querySelector(".sidebar-rail__pin")!;
    drag(pin, "dragstart", transfer);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(true);
    drag(pin, "dragend", transfer);
    await sidebar.updateComplete;
    expect(pins.classList.contains("sidebar-rail__pins--drag-active")).toBe(false);
  });

  it.each([
    { label: "Résumé", icon: undefined, monogram: "R" },
    {
      label: "Architecture",
      icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>')}`,
      monogram: undefined,
    },
  ])("uses the session artwork or title initials for $label", async ({ label, icon, monogram }) => {
    const { sidebar, publish } = await fixture();
    publish({ label, icon });
    await update(sidebar, { sidebarEntries: ["session-rail:agent:main:mine"] });
    const pin = rail(sidebar, "session-rail:agent:main:mine")!;
    const artwork = domProbe(pin);
    expect({ label: artwork.attr("a", "aria-label"), title: pin.getAttribute("title") }).toEqual({
      label,
      title: label,
    });
    expect(artwork.text(".sidebar-rail__monogram")).toBe(monogram);
    if (icon?.startsWith("data:")) {
      expect(artwork.attr(".session-glyph__icon img", "src")).toBe(icon);
    } else {
      expect(artwork.text(".session-glyph__emoji")).toBe(icon);
    }
    expect(artwork.present("svg", ".session-owner-chip")).toEqual([false, false]);
  });

  it("keeps a session shortcut's identity with only running and unread decorations", async () => {
    const { sidebar, sessions, publish, dom } = await fixture();
    const key = "agent:main:mine";
    publish(
      {
        label: "Release Notes",
        icon: "📝",
        hasActiveRun: true,
        status: "running",
        unread: true,
        agentStatus: {
          note: "Waiting for input",
          attention: "key",
          expiresAt: Date.now() + 60_000,
        },
        worktree: { id: "wt-notes", branch: "docs/notes", repoRoot: "/repo" },
      },
      key,
    );
    sessions.sessions.setPullRequestSummary(key, { numbers: [1], state: "open" });
    await update(sidebar, { storedOutboxes: outbox(key), sidebarEntries: [`session-rail:${key}`] });
    const row = dom.query(`[data-session-key="${key}"]`)!;
    expect(
      domProbe(row).present(
        ".sidebar-session-attention__icon",
        ".session-row-badge--attention",
        ".session-row-badge--draft",
      ),
    ).toEqual([true, true, true]);
    const pin = dom.query(`.sidebar-rail [data-sidebar-entry="session-rail:${key}"]`)!;
    expect(pin.querySelector(".session-glyph__emoji")?.textContent).toBe("📝");
    expect(pin.querySelectorAll(".session-glyph__ring")).toHaveLength(1);
    expect(pin.querySelectorAll(".session-glyph__badge--unread")).toHaveLength(1);
    expect(
      pin.querySelector(
        ".sidebar-session-attention__icon, .session-row-badges, [data-pull-request-state], .session-owner-chip",
      ),
    ).toBeNull();
  });

  it("supports native page drop, direct pin reordering, and context-menu unpin with unloaded refs retained", async () => {
    const retained = ["person:offline", "session-rail:agent:other:unloaded"];
    const { sidebar, dom } = await fixture({
      sidebarEntries: retained,
      navigationView: "pages",
    });
    const transfer = createDataTransferStub();
    drag(dom.query('.sidebar-pages [data-sidebar-entry="route:usage"]')!, "dragstart", transfer);
    drag(dom.query(".sidebar-rail__pins")!, "drop", transfer);
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual([...retained, "route:usage"]);
    const pin = rail(sidebar, "route:usage")!;
    const reorder = createDataTransferStub();
    drag(pin.querySelector("a")!, "dragstart", reorder);
    drag(rail(sidebar, "person:offline")!, "drop", reorder);
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["route:usage", ...retained]);
    await sidebar.sidebarMenus.preloadMenuRenderer();
    pin.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    await removePin(sidebar);
    expect(sidebar.sidebarEntries).toEqual(retained);
  });

  it("retires pending pin hints while a context menu owns keyboard focus", async () => {
    const { sidebar, dom } = await fixture({
      sidebarEntries: ["session-rail:agent:main:mine", "session-rail:agent:main:other"],
    });
    await sidebar.sidebarMenus.preloadMenuRenderer();
    const source = link(sidebar, "session-rail:agent:main:mine");
    const hovered = link(sidebar, "session-rail:agent:main:other");
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    source.focus();
    onTestFinished(installTitleTooltips(document));
    dispatchMousePointer(hovered, "pointerover");
    const hint = tooltip();
    hint.delay = 100;
    await hint.updateComplete;
    expect(hint.content).not.toBe("");
    expect(hint.hasAttribute("open")).toBe(false);
    source.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sidebar.updateComplete;
    await hint.updateComplete;
    expect(dom.query(".sidebar-rail-pin-menu")).not.toBeNull();
    vi.advanceTimersByTime(100);
    expect(hint.hasAttribute("open")).toBe(false);

    await removePin(sidebar);
    await hint.updateComplete;
    dispatchMousePointer(hovered.closest(".sidebar-rail__pin")!, "pointerleave");
    dispatchMousePointer(hovered, "pointerover");
    const reopened = tooltip();
    vi.advanceTimersByTime(150);
    await settleTooltip(reopened);
    expect(reopened.hasAttribute("open")).toBe(true);
  });

  it("toggles the panel from the active view and expands it when switching views", async () => {
    const { sidebar } = await fixture();
    const toggle = vi.fn(() => {
      sidebar.navigationCollapsed = !sidebar.navigationCollapsed;
    });
    sidebar.onToggleSidebar = toggle;
    for (const [view, collapsed] of [
      ["sessions", true],
      ["sessions", false],
      ["pages", false],
      ["pages", true],
      ["online", false],
      ["online", false],
    ] as const) {
      await click(sidebar, `[data-navigation-view="${view}"]`);
      expect(sidebar).toMatchObject({ navigationView: view, navigationCollapsed: collapsed });
      expect(sidebar.activeNavigationViewElement()).toBe(
        collapsed ? undefined : sidebar.querySelector(`[data-navigation-view="${view}"]`),
      );
    }
    expect(toggle).toHaveBeenCalledTimes(4);
    await update(sidebar, { navigationVisible: false });
    expect(sidebar.activeNavigationViewElement()).toBeUndefined();
    await update(sidebar, { navigationVisible: true });
    expect(sidebar.activeNavigationViewElement()).toBe(
      sidebar.querySelector('[data-navigation-view="online"]'),
    );
    sidebar.hostElement.remove();
    expect(sidebar.activeNavigationViewElement()).toBeUndefined();
  });

  it("preserves a mobile drawer when a stored desktop preference is collapsed", async () => {
    const { sidebar } = await fixture();
    mockMobile(() => true);
    sidebar.navigationCollapsed = true;
    const toggle = vi.fn();
    await update(sidebar, { onToggleSidebar: toggle });
    for (const view of ["sessions", "pages"]) {
      await click(sidebar, `[data-navigation-view="${view}"]`);
    }
    expect(sidebar.navigationView).toBe("pages");
    expect(toggle).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "collapses shortcut navigation only on desktop (mobile: %s)",
    async (mobile) => {
      mockMobile((query) => query.includes("max-width") && mobile);
      const { sidebar, gateway, dom } = await fixture();
      gateway.publish({
        hello: {
          ...gatewayHelloForMethods(["chat.history", "chat.send"]),
          controlUiTabs: [
            {
              group: "control",
              id: "logbook",
              label: "Logbook",
              pluginId: "logbook",
              slug: "logbook",
            },
          ],
        },
      });
      sidebar.sidebarEntries = [
        "session-rail:agent:main:mine",
        "route:usage",
        "person:other",
        "plugin:logbook/logbook",
      ];
      const toggle = vi.fn(() => {
        sidebar.navigationCollapsed = !sidebar.navigationCollapsed;
      });
      await update(sidebar, { onToggleSidebar: toggle });
      for (const selector of [
        '[data-sidebar-entry="session-rail:agent:main:mine"] a',
        '[data-sidebar-entry="route:usage"] a',
        '[data-sidebar-entry="person:other"] a',
        '[data-sidebar-entry="plugin:logbook/logbook"] a',
        ".sidebar-footer-bar__home",
      ]) {
        await update(sidebar, { navigationCollapsed: false });
        const shortcut = dom.query<HTMLElement>(`.sidebar-rail ${selector}`);
        expect(shortcut).not.toBeNull();
        shortcut!.click();
        await sidebar.updateComplete;
        expect(sidebar.navigationCollapsed, selector).toBe(!mobile);
      }
      expect(toggle).toHaveBeenCalledTimes(mobile ? 0 : 5);
    },
  );

  it("opens the existing agent menu from the named avatar at the top of the rail", async () => {
    const { sidebar, dom } = await fixture({}, TWO_AGENTS);
    const agent = dom.query<HTMLButtonElement>(".sidebar-rail .sidebar-agent-card__main");
    expect(agent).not.toBeNull();
    expect(agent?.getAttribute("aria-label")).toContain("Molty");
    await openAgentMenu(sidebar);
    expect(
      dom.present(".sidebar-agent-menu", '[data-value="agent:research"]', ".sidebar-brand"),
    ).toEqual([true, true, false]);
  });

  it("settles retained menu avatars through a sidebar view-root replacement", async () => {
    setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"]);
    onTestFinished(() => setAvatarGatewayOrigin(null));
    const response = createDeferred<Response>();
    onTestFinished(() => response.resolve(new Response(null, { status: 404 })));
    const nativeFetch = globalThis.fetch;
    const fetchAvatar = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      return url.pathname === "/avatar/research"
        ? fetchAvatar(input, init)
        : nativeFetch(input, init);
    });
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:retained-menu-avatar");
        static override revokeObjectURL = vi.fn();
      },
    );
    const agents = {
      ...TWO_AGENTS,
      agents: TWO_AGENTS.agents.map((agent) =>
        agent.id === "research"
          ? Object.assign({}, agent, { identity: { avatar: "/avatar/research?v=1" } })
          : agent,
      ),
    };
    const { sidebar, provider, context, dom } = await fixture({}, agents);
    await openAgentMenu(sidebar);
    await waitForSolid(() => expect(fetchAvatar).toHaveBeenCalledOnce());
    provider.setContext({ ...context, basePath: "/control" });
    await sidebar.updateComplete;
    await vi.dynamicImportSettled();
    response.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
    );
    await waitForSolid(() =>
      expect(dom.attr('[data-value="agent:research"] img', "src")).toBe(
        "blob:retained-menu-avatar",
      ),
    );
    expect(fetchAvatar).toHaveBeenCalledOnce();
  });

  it("updates the avatar of a retained pinned person when owner metadata changes", async () => {
    const { sidebar, sessions, result } = await fixture({ sidebarEntries: ["person:other"] });
    const pin = rail(sidebar, "person:other");
    const person = link(sidebar, "person:other");
    const avatar = person.querySelector(".viewer-avatar")!;
    expect(avatar.getAttribute("aria-label")).toBe("Other");
    expect(avatar.querySelector(".viewer-avatar__initials")?.textContent).toBe("O");

    sessions.publishList({
      agentId: "main",
      result: {
        ...result,
        owners: result.owners!.map((owner) =>
          owner.id === "other" ? Object.assign({}, owner, { label: "Updated Person" }) : owner,
        ),
      },
    });
    await settleLitElement(sidebar);
    expect(rail(sidebar, "person:other")).toBe(pin);
    expect(link(sidebar, "person:other")).toBe(person);
    expect(person.getAttribute("aria-label")).toBe("Updated Person");
    expect(person.querySelector(".viewer-avatar")).toBe(avatar);
    expect(avatar.getAttribute("aria-label")).toBe("Updated Person");
    expect(avatar.querySelector(".viewer-avatar__initials")?.textContent).toBe("UP");
  });

  it("pins a person with native drag and retains a safe destination after they go offline", async () => {
    const { sidebar, dom } = await fixture();
    dom.query<HTMLButtonElement>('[data-navigation-view="online"]')!.click();
    sidebar.sessionData.presencePayload = {
      presence: [
        {
          ts: Date.now(),
          user: { id: "other", name: "Other", identity: { type: "profile", id: "other" } },
        },
      ],
    };
    await sidebar.updateComplete;
    const transfer = createDataTransferStub();
    drag(dom.query(".sidebar-online__row")!, "dragstart", transfer);
    drag(dom.query(".sidebar-rail__pins")!, "drop", transfer);
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["person:other"]);
    sidebar.sessionData.presencePayload = { presence: [] };
    sidebar.invalidate();
    await sidebar.updateComplete;
    const person = link(sidebar, "person:other");
    expect(person).not.toBeNull();
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    person.click();
    expect(navigate).toHaveBeenCalledWith(
      "activity",
      expect.objectContaining({ pathname: expect.stringContaining("activity") }),
    );
  });

  it("opens a pinned dashboard on its saved face instead of forcing chat", async () => {
    const { sidebar, publish } = await fixture();
    publish({ boardFace: "dashboard" });
    sidebar.sidebarEntries = ["session-rail:agent:main:mine"];
    sidebar.invalidate();
    await sidebar.updateComplete;
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    link(sidebar, "session-rail:agent:main:mine").click();
    expect(navigate).toHaveBeenCalledWith(
      "dashboard",
      expect.objectContaining({ pathname: expect.stringContaining("dashboard") }),
    );
  });

  it("resolves an unloaded pinned session once and uses its real label, icon, and navigation", async () => {
    const {
      sidebar,
      append,
      result,
      key,
      pending,
      read: describeRead,
      navigate,
      dom,
    } = await pinLookup();
    await update(sidebar, { sidebarEntries: [`session-rail:${key}`] });
    expect(dom.query(`.sidebar-rail [data-sidebar-entry="session-rail:${key}"]`)).toBeNull();
    expect(describeRead).toHaveBeenCalledExactlyOnceWith({ key });
    const cached = cachedPin(key);
    await seed(sidebar, [cached]);
    expect(dom.query('.sidebar-rail a[aria-label="Saved title"]')).not.toBeNull();
    expect(describeRead).toHaveBeenCalledTimes(1);
    pending.resolve({
      session: { ...result.sessions[1]!, key, label: "Release notes", icon: "📝" },
    });
    await pending.promise;
    await settleLitElement(sidebar);
    const loaded = link(sidebar, `session-rail:${key}`);
    expect(loaded.getAttribute("aria-label")).toBe("Release notes");
    expect(loaded.querySelector(".session-glyph__emoji")?.textContent).toBe("📝");
    expect(loaded.getAttribute("href")).toContain("unloaded");
    expect(navigate).not.toHaveBeenCalled();
    loaded.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(describeRead).toHaveBeenCalledTimes(1);
    await seed(sidebar, [cached]);
    expect(loaded.getAttribute("aria-label")).toBe("Release notes");
    // Once the authoritative row loads, it wins over the scoped descriptor snapshot.
    append({ key, label: "Current title", icon: "🚀" });
    await settleLitElement(sidebar);
    expect(link(sidebar, `session-rail:${key}`).getAttribute("aria-label")).toBe("Current title");
  });

  it("retires cached pin descriptors when the source changes without reading pins", async () => {
    const { sidebar, sessions, gateway, result, context, provider, dom } = await fixture();
    const key = "agent:other:unloaded";
    const read = vi
      .spyOn(sessions.sessions, "describe")
      .mockResolvedValueOnce({ session: { ...result.sessions[1]!, key, label: "Old source" } })
      .mockResolvedValueOnce({ session: { ...result.sessions[1]!, key, label: "Fresh source" } });
    sidebar.sidebarEntries = [`session-rail:${key}`];
    await settleLitElement(sidebar);
    expect(dom.query('.sidebar-rail a[aria-label="Old source"]')).not.toBeNull();

    sidebar.sidebarEntries = [];
    await sidebar.updateComplete;
    const otherSessions = createSessionsHarness("main", ["agent:main:main"]);
    provider.setContext(createContext(gateway.gateway, otherSessions.sessions));
    await sidebar.updateComplete;
    provider.setContext(context);
    await sidebar.updateComplete;
    sidebar.sidebarEntries = [`session-rail:${key}`];
    await settleLitElement(sidebar);

    expect(read).toHaveBeenCalledTimes(2);
    expect(dom.query('.sidebar-rail a[aria-label="Fresh source"]')).not.toBeNull();
    expect(dom.query('.sidebar-rail a[aria-label="Old source"]')).toBeNull();
  });

  it("retains a lookup across a synchronous host move within the same connection", async () => {
    const { sidebar, result, pending, read, dom } = await pinLookup();
    await update(sidebar, { sidebarEntries: ["session-rail:agent:other:unloaded"] });
    const parent = sidebar.parentElement!;
    sidebar.remove();
    parent.append(sidebar.hostElement);
    pending.resolve({
      session: { ...result.sessions[1]!, key: "agent:other:unloaded", label: "Detached result" },
    });
    await pending.promise;
    await sidebar.updateComplete;
    expect(read).toHaveBeenCalledTimes(1);
    expect(dom.query('.sidebar-rail a[aria-label="Detached result"]')).not.toBeNull();
  });

  it("keeps cached pins while chat loads and skips queued reads after the sidebar is removed", async () => {
    const { sidebar, sessions, result, dom } = await fixture();
    const key = "agent:other:unloaded";
    const bootstrap = sidebar.sessionDataContext!.connectionBootstrap;
    bootstrap.setForegroundRoute("agent:main:selected");
    const read = vi.spyOn(sessions.sessions, "describe").mockResolvedValue({
      session: { ...result.sessions[1]!, key, label: "Current title" },
    });
    sidebar.sidebarEntries = [`session-rail:${key}`];
    sidebar.pinnedSessions.seed([cachedPin(key)]);
    await sidebar.updateComplete;
    expect(dom.query('.sidebar-rail a[aria-label="Saved title"]')).not.toBeNull();
    expect(read).not.toHaveBeenCalled();

    const parent = sidebar.parentElement!;
    sidebar.remove();
    bootstrap.setForegroundRoute(null);
    await bootstrap.run({}, async () => {});
    expect(read).not.toHaveBeenCalled();

    parent.append(sidebar.hostElement);
    await settleLitElement(sidebar);
    expect(read).toHaveBeenCalledExactlyOnceWith({ key });
    expect(dom.query('.sidebar-rail a[aria-label="Current title"]')).not.toBeNull();
  });

  it("uses rows loaded during bootstrap instead of describing queued pins", async () => {
    const { sidebar, sessions, result, dom, append } = await fixture();
    const loadedKey = "agent:main:loaded-during-bootstrap";
    const outsideKey = "agent:other:outside-window";
    const bootstrap = sidebar.sessionDataContext!.connectionBootstrap;
    bootstrap.setForegroundRoute("agent:main:selected");
    const read = vi.spyOn(sessions.sessions, "describe").mockResolvedValue({
      session: { ...result.sessions[1]!, key: outsideKey, label: "Outside window" },
    });
    sidebar.sidebarEntries = [loadedKey, outsideKey].map((key) => `session-rail:${key}`);
    await sidebar.updateComplete;
    expect(read).not.toHaveBeenCalled();

    append({ key: loadedKey, label: "Live row", boardFace: "dashboard" });
    await sidebar.updateComplete;
    bootstrap.setForegroundRoute(null);
    await bootstrap.run({}, async () => {});
    await settleLitElement(sidebar);

    expect(read).toHaveBeenCalledExactlyOnceWith({ key: outsideKey });
    expect(link(sidebar, `session-rail:${loadedKey}`).getAttribute("aria-label")).toBe("Live row");
    expect(link(sidebar, `session-rail:${loadedKey}`).getAttribute("href")).toContain("dashboard");
    expect(dom.query('.sidebar-rail a[aria-label="Outside window"]')).not.toBeNull();
  });

  it("paints a burst of unloaded pins together without changing their saved order", async () => {
    const { sidebar, sessions, result, dom } = await fixture();
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const keys = Array.from({ length: 30 }, (_, index) => `agent:other:pin-${index}`);
    const reads = keys.map(() =>
      createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>(),
    );
    vi.spyOn(sessions.sessions, "describe").mockImplementation(
      ({ key }) => reads[keys.indexOf(key)]!.promise,
    );
    await update(sidebar, { sidebarEntries: keys.map((key) => `session-rail:${key}`) });
    const render = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "commitRender");
    for (const [index, pending] of reads.entries()) {
      pending.resolve({
        session: { ...result.sessions[1]!, key: keys[index]!, label: `Pinned ${index}` },
      });
      await pending.promise;
      await sidebar.updateComplete;
    }
    expect(render).not.toHaveBeenCalled();
    for (const callback of frames.values()) {
      callback(0);
    }
    frames.clear();
    await sidebar.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      [...dom.all(".sidebar-rail [data-sidebar-entry]")].map((row) =>
        row.getAttribute("data-sidebar-entry"),
      ),
    ).toEqual(keys.map((key) => `session-rail:${key}`));
  });

  it.each(["not-found", "failure"] as const)(
    "hides %s sessions and unavailable destinations without pruning or retrying",
    async (outcome) => {
      const { sidebar, pending, read, navigate, dom } = await pinLookup("agent:other:missing");
      const showToast = vi.spyOn(toast, "showToast");
      sidebar.enabledRouteIds = ["chat"];
      const entries = [
        "session-rail:agent:other:missing",
        "route:usage",
        "plugin:missing/navigation",
      ];
      await update(sidebar, { sidebarEntries: entries });
      const cached = cachedPin("agent:other:missing");
      await seed(sidebar, [cached]);
      expect(dom.query('.sidebar-rail a[aria-label="Saved title"]')).not.toBeNull();
      if (outcome === "failure") {
        pending.reject(new Error("Unavailable"));
      } else {
        pending.resolve({ session: null });
      }
      await pending.promise.catch(() => undefined);
      await settleLitElement(sidebar);
      await seed(sidebar, [cached]);
      expect(dom.all(".sidebar-rail__pin")).toHaveLength(0);
      expect(sidebar.sidebarEntries).toEqual(entries);
      expect(read).toHaveBeenCalledTimes(1);
      expect(showToast).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "failure"] as const)(
    "does not publish a superseded connection lookup (%s)",
    async (outcome) => {
      const { sidebar, gateway, result, pending, read, navigate, dom } = await pinLookup(
        undefined,
        true,
      );
      const showToast = vi.spyOn(toast, "showToast");
      await update(sidebar, { sidebarEntries: ["session-rail:agent:other:unloaded"] });
      expect(read).toHaveBeenCalledTimes(1);
      gateway.publish({ phase: "reconnecting" });
      await sidebar.updateComplete;
      gateway.publish({ phase: "connected" });
      await sidebar.updateComplete;
      if (outcome === "success") {
        pending.resolve({
          session: { ...result.sessions[1]!, key: "agent:other:unloaded", label: "Old connection" },
        });
      } else {
        pending.reject(new Error("Old connection"));
      }
      await pending.promise.catch(() => undefined);
      await sidebar.updateComplete;
      expect(read).toHaveBeenCalledTimes(2);
      expect(dom.all(".sidebar-rail__pin")).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
    },
  );

  it("discovers MCP apps only while Pages is mounted", async () => {
    const { sidebar, gateway } = await fixture();
    const request = vi.spyOn(gateway.gateway.snapshot.client!, "request").mockResolvedValue({
      servers: [],
    });
    const discoveries = () =>
      request.mock.calls.filter(([method]) => method === "mcp.app.discover");
    gateway.publish({ hello: gatewayHelloForMethods(["mcp.app.discover"]) });
    await sidebar.updateComplete;
    gateway.publishEvent("config.changed", {});
    await sidebar.updateComplete;
    expect(discoveries()).toHaveLength(0);

    await click(sidebar, '[data-navigation-view="pages"]');
    await waitForSolid(() => expect(discoveries()).toHaveLength(1));
    await click(sidebar, '[data-navigation-view="sessions"]');
    gateway.publishEvent("config.changed", {});
    await sidebar.updateComplete;
    expect(discoveries()).toHaveLength(1);

    await click(sidebar, '[data-navigation-view="pages"]');
    await waitForSolid(() => expect(discoveries()).toHaveLength(2));
  });

  it("does not recreate catalog observations in an update queued before removal", async () => {
    const { sidebar, sessions, gateway } = await fixture();
    const parent = sidebar.parentElement!;
    const observeList = sessions.sessions.observeList;
    const dispose = vi.fn();
    const observe = vi
      .spyOn(sessions.sessions, "observeList")
      .mockImplementation((query, listener) => {
        const observation = observeList(query, listener);
        return query.source === "dashboard"
          ? {
              ...observation,
              dispose: () => {
                dispose();
                observation.dispose();
              },
            }
          : observation;
      });
    const catalogQueries = () =>
      observe.mock.calls.filter(
        ([query]) => query.includeOwnerSessionCounts || query.source === "dashboard",
      );
    expect(catalogQueries()).toHaveLength(0);
    sidebar.navigationView = "pages";
    sidebar.remove();
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(0);
    parent.append(sidebar.hostElement);
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(1);
    expect(sidebar.querySelector(".sidebar-pages")).not.toBeNull();
    sidebar.navigationView = "sessions";
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
    gateway.publish({ phase: "reconnecting" });
    await sidebar.updateComplete;
    expect(dispose).toHaveBeenCalledOnce();
    gateway.publish({ phase: "connected" });
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(1);
    sidebar.navigationView = "pages";
    await sidebar.updateComplete;
    expect(catalogQueries()).toHaveLength(2);
  });

  it("observes Pages when Solid mounts the sidebar into a connected application", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:dashboard"]);
    sessions.sessions.state.result!.sessions[0]!.label = "Team board";
    const context = createContext(gateway.gateway, sessions.sessions);
    const provider = createApplicationContextProvider(context);
    document.body.append(provider);
    const view = mountSolid(
      () =>
        createComponent(ApplicationProvider, {
          value: context,
          get children() {
            return createComponent(AppSidebar, { navigationView: "pages" });
          },
        }),
      { container: provider },
    );
    await waitForSolid(() => {
      expect(
        view.container.querySelector(
          '.sidebar-pages [data-sidebar-entry="session:agent:main:dashboard"]',
        )?.textContent,
      ).toContain("Team board");
    });
  });

  it("renders and paginates the current managed dashboard catalog", async () => {
    const { sidebar, sessions, result } = await fixture();
    const dashboard = { ...result.sessions[1]!, key: "agent:main:dashboard", label: "Team board" };
    sessions.list.mockResolvedValue({
      ...result,
      sessions: [dashboard],
      hasMore: true,
      nextOffset: 7,
    });
    sidebar.navigationView = "pages";
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector('.sidebar-pages [data-sidebar-entry="session:agent:main:dashboard"]')
        ?.textContent,
    ).toContain("Team board");
    const pending = createDeferred<typeof result>();
    sessions.list.mockClear().mockReturnValueOnce(pending.promise);
    const more = sidebar.querySelector<HTMLButtonElement>(".sidebar-pages > .btn")!;
    more.click();
    more.click();
    expect(sessions.list).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: "dashboard", offset: 7 }),
    );
    pending.resolve({
      ...result,
      sessions: [{ ...dashboard, key: "agent:main:second", label: "Second board" }],
      hasMore: false,
    });
    await pending.promise;
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector('.sidebar-pages [data-sidebar-entry="session:agent:main:second"]')
        ?.textContent,
    ).toContain("Second board");
    expect(sidebar.querySelector(".sidebar-pages > .btn")).toBeNull();
  });

  it("stores only stable person references", () => {
    expect(
      normalizeSidebarEntries(["person:self", "person:self", "person:  ", "person:display name"]),
    ).toEqual(["person:self"]);
  });
});
