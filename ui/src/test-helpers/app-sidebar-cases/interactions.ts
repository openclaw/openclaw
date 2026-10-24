import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import "../../lib/toast-host.tsx";
import { loadStoredHiddenSessionCatalogIds } from "../../components/app-sidebar-session-types.ts";
import {
  createGatewayHarness,
  catalogPage,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  successfulSessionPatch,
} from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import { menuItem } from "../session-menu.ts";
import { waitForFast } from "../wait-for.ts";
import {
  click,
  mountMultiSelect,
  openContextMenu,
  rowLink,
  selectedRowKeys,
  sessionMenu,
} from "./multi-select-support.ts";
import { sidebarDriver } from "./sidebar-driver.test-support.ts";
import "../../components/app-sidebar.tsx";

describe("AppSidebar multi-select", () => {
  async function selection(methods?: string[] | null) {
    const fixture = await mountMultiSelect(methods);
    const { sidebar } = fixture;
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    const select = (key: string, init: MouseEventInit = {}) => {
      click(rowLink(sidebar, `agent:main:${key}`), init);
      return sidebar.updateComplete;
    };
    return { ...fixture, navigate, select, dom: sidebarDriver(sidebar) };
  }
  it("restores the thread link when Tab exits its keyboard context menu", async () => {
    const { sidebar } = await mountMultiSelect();
    const trigger = rowLink(sidebar, "agent:main:a");
    trigger.focus();

    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await sidebar.updateComplete;

    const item = menuItem(await sessionMenu(sidebar), "Pin session");
    item.focus();
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(trigger);
  });

  it("lets Control-click open session links through the browser", async () => {
    const { sidebar, navigate, dom } = await selection();
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });

    rowLink(sidebar, "agent:main:a").dispatchEvent(clickEvent);
    await dom.update();

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(selectedRowKeys(sidebar)).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("option-click toggles selection and plain click clears it while navigating", async () => {
    const { sidebar, navigate, select } = await selection();

    const optionClick = new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true });
    rowLink(sidebar, "agent:main:a").dispatchEvent(optionClick);
    await select("b", { altKey: true });
    expect(optionClick.defaultPrevented).toBe(true);
    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a", "agent:main:b"]);

    await select("b", { altKey: true });
    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a"]);

    await select("c");
    expect(selectedRowKeys(sidebar)).toEqual([]);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("shift-click extends the selection from the anchor across the visible order", async () => {
    const { sidebar, select } = await selection();

    click(rowLink(sidebar, "agent:main:a"), { altKey: true });
    await select("c", { shiftKey: true });

    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a", "agent:main:b", "agent:main:c"]);
  });

  it("disables batch archive when method metadata is missing", async () => {
    const { sidebar, harness, request } = await mountMultiSelect(null);

    click(rowLink(sidebar, "agent:main:a"), { altKey: true });
    click(rowLink(sidebar, "agent:main:b"), { altKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:a");
    await sidebar.updateComplete;

    const menu = await sessionMenu(sidebar);
    const archive = menu.querySelector<HTMLButtonElement>('[data-shortcut="a"]');
    expect(archive?.disabled).toBe(true);
    archive?.click();
    await Promise.resolve();

    expect(harness.patch).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "sessions.patchMany")).toEqual([]);
    expect(harness.patchMany).not.toHaveBeenCalled();
    expect(harness.reconcileMutation).not.toHaveBeenCalled();
  });

  it("hides an archiving current thread immediately without navigating away", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKeySpy = vi.spyOn(gatewayHarness.gateway, "setSessionKey");
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:a",
      "agent:main:b",
    ]);
    const pendingPatch = deferred<ReturnType<typeof successfulSessionPatch>>();
    harness.patch.mockReturnValueOnce(pendingPatch.promise);
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
    sidebar.connected = true;
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:a";
    await sidebar.updateComplete;

    openContextMenu(sidebar, "agent:main:a");
    await sidebar.updateComplete;
    (await sessionMenu(sidebar)).querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();

    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:main:a"]')).toBeNull();
    expect(setSessionKeySpy).not.toHaveBeenCalled();

    const result = harness.sessions.state.result!;
    harness.publishList({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:a" ? Object.assign({}, row, { archived: true }) : row,
        ),
      },
    });
    pendingPatch.resolve(successfulSessionPatch("agent:main:a"));

    await waitForFast(() =>
      expect(sidebar.querySelector('[data-session-key="agent:main:a"]')).toBeNull(),
    );
    expect(setSessionKeySpy).not.toHaveBeenCalled();
  });
});

describe("AppSidebar catalog session rows", () => {
  beforeEach(() => vi.useFakeTimers());

  async function mountWithCatalog(
    session: Partial<SessionCatalogSession> = {},
    configure?: (result: SessionsCatalogListResult) => void,
  ) {
    const result = catalogPage([{ threadId: "thread-1", name: "Release checklist" }]);
    Object.assign(result.catalogs[0]!.hosts[0]!.sessions[0]!, session);
    configure?.(result);
    const request = vi.fn().mockResolvedValue(result);
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gateway.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["sessions.catalog.list"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersToNextFrame();
    await settleLitElement(sidebar);
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    return { sidebar, request, navigate, dom: sidebarDriver(sidebar) };
  }

  it("opens the catalog view menu from its header and hides that section with undo", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    await toastHost.updateComplete;
    const { dom, navigate } = await mountWithCatalog();
    const header = dom.query<HTMLElement>(
      '[data-session-section="catalog:codex"] .sidebar-recent-sessions__head',
    );
    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 36,
    });
    header!.dispatchEvent(contextMenu);
    await dom.update();

    expect(contextMenu.defaultPrevented).toBe(true);
    const menu = dom.query<HTMLElement>(".sidebar-catalog-view-menu");
    const hide = menu?.querySelector<HTMLElement>('[data-value="hide-catalog"]');
    expect(menu).not.toBeNull();
    expect(hide).not.toBeNull();
    await dom.click(hide!);

    expect(loadStoredHiddenSessionCatalogIds().has("codex")).toBe(true);
    expect(dom.query('[data-session-section="catalog:codex"]')).toBeNull();

    await toastHost.updateComplete;
    const message = toastHost.querySelector(".app-toast__message")?.textContent ?? "";
    expect(message).toContain("Codex");
    expect(message).toContain("Settings > Appearance > Sidebar");

    const recovery = toastHost.querySelector<HTMLAnchorElement>(".app-toast__message a");
    expect(recovery?.getAttribute("href")).toBe(
      "/settings/appearance?section=__appearance__#settings-appearance-sidebar",
    );
    recovery?.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("appearance", {
      search: "?section=__appearance__",
      hash: "#settings-appearance-sidebar",
    });

    await dom.click(toastHost.querySelector<HTMLButtonElement>(".app-toast__action")!);
    expect(loadStoredHiddenSessionCatalogIds().has("codex")).toBe(false);
    expect(dom.query('[data-session-section="catalog:codex"]')).not.toBeNull();
  });

  it("renders local rows directly and keeps paired-node rows under their host heading", async () => {
    const { dom } = await mountWithCatalog(
      { threadId: "thread-local", name: "Local session" },
      (result) => {
        const catalog = result.catalogs[0]!;
        catalog.hosts.push({
          hostId: "node:devbox",
          label: "Dev Box",
          kind: "node",
          nodeId: "devbox",
          connected: true,
          sessions: [
            {
              ...catalog.hosts[0]!.sessions[0]!,
              threadId: "thread-node",
              name: "Node session",
              status: "stored",
              canContinue: false,
              canArchive: false,
            },
          ],
        });
      },
    );

    const section = dom.query('[data-session-section="catalog:codex"]');
    const local = section?.querySelector('[data-session-catalog-host="gateway:local"]');
    const node = section?.querySelector('[data-session-catalog-host="node:devbox"]');
    expect(section?.querySelector(".sidebar-session-group-count")).toBeNull();
    expect(local?.querySelector(".sidebar-session-catalog-host__head")).toBeNull();
    expect(local?.textContent).toContain("Local session");
    expect(local?.textContent).not.toContain("Node session");
    expect(node?.querySelector(".sidebar-session-catalog-host__label")?.textContent).toBe(
      "Dev Box",
    );
    expect(node?.textContent).toContain("Node session");
    expect(node?.textContent).not.toContain("Local session");

    await dom.click(section!.querySelector<HTMLButtonElement>(".sidebar-session-group-toggle")!);
    expect(
      dom.text('[data-session-section="catalog:codex"] .sidebar-session-group-count')?.trim(),
    ).toBe("2");
  });

  it.each([true, false])(
    "routes terminal-preferred clicks and gates the menu (eligible: %s)",
    async (canOpenTerminal) => {
      const { dom, navigate } = await mountWithCatalog({ name: "Resume me", canOpenTerminal });
      await dom.update({ catalogOpenTarget: "terminal", terminalAvailable: true });
      const row = dom.query<HTMLElement>('[data-session-key*="thread-1"]')!;
      row.querySelector<HTMLAnchorElement>("a")!.click();
      expect(navigate).toHaveBeenCalledWith(canOpenTerminal ? "terminal" : "chat", {
        pathname: canOpenTerminal ? "/terminal" : "/chat/main",
        search: "?catalog=codex&host=gateway%3Alocal&thread=thread-1",
        ...(canOpenTerminal ? { hash: "" } : {}),
      });
      if (canOpenTerminal) {
        return;
      }
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
      await dom.update();
      const menu = dom.query("openclaw-catalog-session-menu")!;
      await menu.updateComplete;
      const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      const values = [...items].map((item) => item.dataset.value);
      expect(values).toEqual(["viewer", "import", "terminal", "delete"]);
      expect(items[2]?.disabled).toBe(true);
      expect(row.querySelector("[data-catalog-session-menu]")).not.toBeNull();

      const keyboardContextMenu = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "F10",
        shiftKey: true,
      });
      row.querySelector("a")?.dispatchEvent(keyboardContextMenu);
      await dom.update();
      expect(dom.query("openclaw-catalog-session-menu")).not.toBeNull();
      expect(keyboardContextMenu.defaultPrevented).toBe(true);
    },
  );

  it("marks the routed catalog session row active without a phantom chat row", async () => {
    const { dom } = await mountWithCatalog();
    const sessionKey = "agent:main:catalog:codex:gateway%3Alocal:thread-1";
    await dom.update({ activeRouteId: "chat", sessionKey });

    const active = dom.all(".sidebar-recent-session--active");
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute("data-session-key")).toBe(sessionKey);
    expect(active[0]?.getAttribute("role")).toBe("listitem");
    expect(active[0]?.closest('[role="list"]')?.getAttribute("aria-label")).toBe("Local Codex");
    expect(active[0]?.querySelector("a")?.getAttribute("aria-current")).toBe("page");
    expect(active[0]?.querySelector("a")?.hasAttribute("aria-describedby")).toBe(false);
    expect(active[0]?.querySelector(".session-row-trail")).toBeNull();
    // Catalogs nest inside Coding; classify rows by their closest section.
    const chatRows = [...dom.all(".sidebar-recent-sessions__group [data-session-key]")]
      .filter((row) => !row.closest('[data-session-section^="catalog:"]'))
      .map((row) => row.getAttribute("data-session-key"));
    expect(chatRows).not.toContain(sessionKey);
  });

  it("announces catalog running state through the leading ring", async () => {
    const { dom } = await mountWithCatalog({
      threadId: "thread-running",
      name: "Running catalog",
      status: "running",
    });
    const row = dom.query('[data-session-key*="thread-running"]');
    const link = row?.querySelector("a");
    const ring = row?.querySelector(".sidebar-session-indicator .session-glyph__ring");

    expect(link?.hasAttribute("aria-describedby")).toBe(false);
    expect(link?.hasAttribute("title")).toBe(false);
    expect(ring?.getAttribute("aria-label")).toBe("Active run");
    expect(
      row?.querySelector(".sidebar-recent-session__details-endcap .session-run-spinner"),
    ).toBeNull();
  });
});
