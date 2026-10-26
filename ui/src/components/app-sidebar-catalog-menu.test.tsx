/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarCatalogMenu } from "./app-sidebar-catalog-menu.runtime.tsx";
import { createSidebarCatalogMenu } from "./app-sidebar-catalog-menu.tsx";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";

const popupSelector = "openclaw-catalog-session-menu";
const expectState = (view: ReturnType<typeof mountSolid>, state: string) =>
  waitForSolid(() => expect(view.container.querySelector("output")?.textContent).toBe(state));

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
      return (
        <>
          <output>{view.isOpenFor(request.key) ? "open" : "closed"}</output>
          {view.render(SidebarCatalogMenu)}
        </>
      );
    });
  return { owner, mount };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
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
  await waitForSolid(() => {
    expect(view.container.querySelector("output")?.textContent).toBe("open");
    expect(view.container.querySelector('[data-value="viewer"]')).not.toBeNull();
  });
  if (replace) {
    view.unmount();
    view = mount();
    await expectState(view, "open");
  }
  owner.close();
  expect(owner.isOpen()).toBe(false);
  await waitForSolid(() => {
    expect(view.container.querySelector("output")?.textContent).toBe("closed");
    expect(view.container.querySelector(popupSelector)).toBeNull();
  });
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
