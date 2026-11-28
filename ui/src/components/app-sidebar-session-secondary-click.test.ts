/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  catalogPage,
  createGateway,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";

async function fixture(kind: "session" | "catalog" | "rail") {
  const { sidebar } = await mountSidebar(
    createGateway(
      createTestGatewayClient(
        createGatewayRequestMock(async (method) =>
          method === "users.list" ? { profiles: [] } : {},
        ),
      ),
    ),
    createSessions("main", ["agent:main:main", "agent:main:thread"]),
  );
  sidebar.connected = true;
  sidebar.sidebarEntries = kind === "rail" ? ["session-rail:agent:main:thread"] : [];
  sidebar.sessionData.sessionCatalogs = catalogPage([
    { threadId: "native", name: "Native" },
  ]).catalogs;
  sidebar.sessionData.requestSessionDataUpdate();
  const selector =
    kind === "catalog"
      ? "[data-catalog-session-key] .sidebar-recent-session__link"
      : kind === "rail"
        ? '.sidebar-rail [data-sidebar-entry="session-rail:agent:main:thread"] a'
        : '[data-session-key="agent:main:thread"] .sidebar-recent-session__link';
  await waitForSolid(() => expect(sidebar.querySelector(selector)).not.toBeNull());
  const link = sidebar.querySelector<HTMLAnchorElement>(selector)!;
  expect(sidebar.sidebarSnapshot).toBeNull();
  const open = vi.fn<(x: number, y: number) => void>();
  if (kind === "catalog") {
    const original = sidebar.sidebarMenus.catalogMenu.open;
    vi.spyOn(sidebar.sidebarMenus.catalogMenu, "open").mockImplementation(
      (request, x, y, trigger) => {
        open(x, y);
        original(request, x, y, trigger);
      },
    );
  }
  if (kind !== "catalog") {
    let previous: object | null = null;
    onTestFinished(
      sidebar.sidebarMenus.subscribe(() => {
        const menu =
          kind === "rail"
            ? sidebar.sidebarMenus.railPinMenuPosition
            : sidebar.sidebarMenus.sessionMenu;
        if (menu && menu !== previous) {
          open(menu.x, menu.y);
        }
        previous = menu;
      }),
    );
  }
  const navigate = vi.fn();
  sidebar.onNavigate = navigate;
  return { link, open, navigate };
}

function dispatch(link: HTMLAnchorElement, type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 30,
    ...init,
  });
  // Observe native activation cancellation without letting jsdom try to load a new page.
  let prevented: boolean | undefined;
  const observe = (bubbled: Event) => {
    prevented = bubbled.defaultPrevented;
    bubbled.preventDefault();
  };
  document.addEventListener(type, observe, { once: true });
  link.dispatchEvent(event);
  document.removeEventListener(type, observe);
  return prevented ?? event.defaultPrevented;
}

for (const kind of ["session", "catalog", "rail"] as const) {
  describe(`${kind} sidebar session link`, () => {
    it.each(["click-first", "contextmenu-first"])(
      "opens once for Mac Control-click (%s)",
      async (order) => {
        vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
        const { link, open, navigate } = await fixture(kind);
        const events =
          order === "click-first" ? ["click", "contextmenu"] : ["contextmenu", "click"];
        for (const type of events) {
          const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            clientX: 20,
            clientY: 30,
          });
          link.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
        }
        expect(open).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0]).toEqual([20, 30]);
        expect(navigate).not.toHaveBeenCalled();
      },
    );

    it("opens on repeated Mac Control-clicks without contextmenu", async () => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      const { link, open } = await fixture(kind);
      for (let i = 0; i < 2; i++) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
        link.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(open).toHaveBeenCalledTimes(2);
      link.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      expect(open).toHaveBeenCalledTimes(3);
    });

    it.each([
      ["Win32", { ctrlKey: true }],
      ["Linux x86_64", { ctrlKey: true }],
      ["MacIntel", { metaKey: true }],
      ["MacIntel", { ctrlKey: true, metaKey: true }],
      ["MacIntel", { button: 1 }],
    ] as const)("preserves native modified activation on %s (%j)", async (platform, init) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const { link, open, navigate } = await fixture(kind);
      expect(dispatch(link, "click", init)).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("preserves Shift-click behavior", async () => {
      const { link, open, navigate } = await fixture(kind);
      expect(dispatch(link, "click", { shiftKey: true })).toBe(kind === "session");
      expect(open).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("keeps plain clicks on SPA navigation", async () => {
      const { link, open, navigate } = await fixture(kind);
      expect(dispatch(link, "click")).toBe(true);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
    });
  });
}
