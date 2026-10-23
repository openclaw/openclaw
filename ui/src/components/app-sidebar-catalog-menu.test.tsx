/* @vitest-environment jsdom */

import { lazy, Loading } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createSidebarCatalogMenu } from "./app-sidebar-catalog-menu.tsx";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";

const loading = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, started: false, finished: false };
});
vi.mock("./app-sidebar-catalog-menu-view.tsx", async (original) => {
  loading.started = true;
  await loading.promise;
  const module = await original();
  loading.finished = true;
  return module;
});

const LazyMenuView = lazy(() => import("./app-sidebar-catalog-menu-view.tsx"), {
  export: "SidebarCatalogMenuView",
});
const MenuView = (props: Parameters<typeof LazyMenuView>[0]) => (
  <Loading>
    <LazyMenuView {...props} />
  </Loading>
);

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
          {view.render(MenuView)}
        </>
      );
    });
  return { owner, mount };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("sidebar catalog menu", () => {
  it("defers its view until opening and does not revive a menu closed while loading", async () => {
    onTestFinished(loading.release);
    const { owner, mount } = fixture();
    const view = mount();
    await waitForSolid(() =>
      expect(view.container.querySelector("output")?.textContent).toBe("closed"),
    );
    expect(loading.started).toBe(false);
    owner.open(request, 10, 20);
    await waitForSolid(() => expect(loading.started).toBe(true));
    owner.close();
    loading.release();
    await waitForSolid(() => expect(loading.finished).toBe(true));
    await waitForSolid(() => {
      expect(view.container.querySelector("output")?.textContent).toBe("closed");
      expect(view.container.querySelector("openclaw-catalog-session-menu")).toBeNull();
    });
    owner.open(request, 30, 40);
    await waitForSolid(() =>
      expect(view.container.querySelector('[data-value="viewer"]')).not.toBeNull(),
    );
    expect(view.container.querySelector('[data-value="viewer"]')?.textContent?.trim()).toBe(
      "Open in OpenClaw",
    );
  });

  it("dismisses the hovercard before opening and updates the mounted row", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const order: string[] = [];
    trigger.addEventListener(SESSION_MENU_OPEN_EVENT, () => order.push("dismiss"));
    const { owner, mount } = fixture(() => order.push("open"));
    const view = mount();

    owner.open(request, 10, 20, trigger);

    expect(order).toEqual(["dismiss", "open"]);
    expect(owner.isOpen()).toBe(true);
    expect(owner.isOpenFor(request.key)).toBe(true);
    await waitForSolid(() => {
      expect(view.container.querySelector("output")?.textContent).toBe("open");
      expect(view.container.querySelector('[data-value="viewer"]')).not.toBeNull();
    });
    owner.close();
    expect(owner.isOpen()).toBe(false);
    await waitForSolid(() => {
      expect(view.container.querySelector("output")?.textContent).toBe("closed");
      expect(view.container.querySelector("openclaw-catalog-session-menu")).toBeNull();
    });
  });

  it("projects retained menu state after the mounted view is replaced", async () => {
    const { owner, mount } = fixture();
    const first = mount();
    owner.open(request, 10, 20);
    await waitForSolid(() =>
      expect(first.container.querySelector("output")?.textContent).toBe("open"),
    );
    first.unmount();
    const replacement = mount();
    await waitForSolid(() =>
      expect(replacement.container.querySelector("output")?.textContent).toBe("open"),
    );
    owner.close();
    await waitForSolid(() =>
      expect(replacement.container.querySelector("output")?.textContent).toBe("closed"),
    );
  });

  it("retargets an adopted row without remounting its open popup", async () => {
    const original = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(original, replacement);
    const { owner, mount } = fixture();
    const view = mount();
    owner.open(request, 10, 20, original);
    await waitForSolid(() =>
      expect(view.container.querySelector("openclaw-catalog-session-menu")).not.toBeNull(),
    );
    const popup = view.container.querySelector("openclaw-catalog-session-menu")!;
    original.remove();
    owner.retargetTrigger(request.key, replacement);
    await waitForSolid(() => expect(popup.trigger).toBe(replacement));
    expect(view.container.querySelector("openclaw-catalog-session-menu")).toBe(popup);
  });
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
    await waitForSolid(() =>
      expect(view.container.querySelector("output")?.textContent).toBe("open"),
    );
  }
  owner.close();
  expect(owner.isOpen()).toBe(false);
  await waitForSolid(() => {
    expect(view.container.querySelector("output")?.textContent).toBe("closed");
    expect(view.container.querySelector("openclaw-catalog-session-menu")).toBeNull();
  });
});
