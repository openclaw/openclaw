/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarCatalogMenu } from "./app-sidebar-catalog-menu.runtime.tsx";
import { createSidebarCatalogMenu } from "./app-sidebar-catalog-menu.tsx";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";

const popupSelector = "openclaw-catalog-session-menu";
const item = (menu: Element, action: string) =>
  menu.querySelector<HTMLButtonElement>(`[data-value="${action}"]`)!;
const expectOpen = (view: ReturnType<typeof mountSolid>) =>
  waitForSolid(() => expect(view.container.querySelector('[data-value="viewer"]')).not.toBeNull());

async function mountMenu(props: Partial<HTMLElementTagNameMap[typeof popupSelector]> = {}) {
  const menu = document.createElement(popupSelector);
  Object.assign(menu, props);
  document.body.append(menu);
  await menu.updateComplete;
  return menu;
}

const request: CatalogSessionMenuRequest = {
  key: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
  agentId: "main",
  routeId: "chat",
  navigation: {},
  canOpenTerminal: true,
  canDelete: false,
  name: "Shared session",
  meta: "now",
};

function fixture(beforeOpen = () => {}) {
  const host: Parameters<typeof createSidebarCatalogMenu>[0] = {
    activeRouteId: "chat",
    basePath: "",
    getRouteSessionKey: () => "",
    onNavigate: vi.fn(),
    terminalAvailable: true,
    sessionDataContext: undefined,
    sessionData: {
      beginSessionMutation: vi.fn(),
      isSessionMutationScopeCurrent: vi.fn(),
      archiveSessionCatalog: vi.fn(),
      importSessionCatalog: vi.fn(),
      sessionScopeGeneration: 0,
    },
  };
  const owner = createSidebarCatalogMenu(host, beforeOpen);
  const mount = () =>
    mountSolid(() => {
      const view = owner.createView(host);
      return view.render(SidebarCatalogMenu);
    });
  return { owner, mount };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([false, true])("projects open/close menu state (replace view=%s)", async (replace) => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const order: string[] = [];
  trigger.addEventListener(SESSION_MENU_OPEN_EVENT, () => order.push("dismiss"));
  const { owner, mount } = fixture(() => order.push("open"));
  let view = mount();
  owner.open(request, 10, 20, replace ? undefined : trigger);
  expect(order).toEqual(replace ? ["open"] : ["dismiss", "open"]);
  expect(owner.isOpen()).toBe(true);
  expect(owner.isOpenFor(request.key)).toBe(true);
  await expectOpen(view);
  if (replace) {
    view.unmount();
    view = mount();
    await expectOpen(view);
  }
  owner.close();
  expect(owner.isOpen()).toBe(false);
  await waitForSolid(() => expect(view.container.querySelector(popupSelector)).toBeNull());
});

it.each(["terminal", "viewer"] as const)(
  "dispatches %s before closing, including synchronous removal",
  async (action) => {
    const warnings = vi.spyOn(console, "warn");
    let backingState: { open: true } | null = { open: true };
    const order: string[] = [];
    const onClose = () => {
      backingState = null;
      order.push("close");
    };
    const menu = await mountMenu({
      onAction: (selected) => {
        order.push(backingState ? selected : "cleared");
        if (action === "viewer") {
          menu.remove();
        }
      },
      onClose,
    });
    item(menu, action).click();

    await waitForSolid(() => expect(order).toEqual([action, "close"]));
    expect(
      warnings.mock.calls.filter(
        ([message]) => typeof message === "string" && message.includes("[NO_OWNER_EFFECT]"),
      ),
    ).toEqual([]);
  },
);

it("opens and focuses the native menu while keeping unavailable terminal selection disabled", async () => {
  const onAction = vi.fn();
  const menu = await mountMenu({ lastActive: "57d", terminalDisabled: true, onAction });
  const terminal = item(menu, "terminal");
  await waitForSolid(() => expect(document.activeElement).toBe(item(menu, "viewer")));
  expect(menu.querySelector('[role="menu"]')!.matches(":popover-open")).toBe(true);
  expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  expect(terminal).toMatchObject({
    disabled: true,
    title: "Terminal opening is unavailable for this session.",
  });
  terminal.click();
  expect(onAction).not.toHaveBeenCalled();
});

it("retargets an adopted row without remounting its open popup", async () => {
  const original = document.createElement("button");
  const replacement = document.createElement("button");
  document.body.append(original, replacement);
  const { owner, mount } = fixture();
  const view = mount();
  owner.open(request, 10, 20, original);
  await waitForSolid(() => expect(view.container.querySelector(popupSelector)).not.toBeNull());
  const popup = view.container.querySelector(popupSelector)!;
  original.remove();
  owner.retargetTrigger(request.key, replacement);
  await waitForSolid(() => expect(popup.trigger).toBe(replacement));
  expect(view.container.querySelector(popupSelector)).toBe(popup);
});
