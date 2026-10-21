import { createSignal, flush, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { NAV_DRAWER_TOGGLE_REGISTRATION } from "../app/navigation-surface.ts";
import { RouteElements, type RouteElementEvent } from "../app/route-elements.ts";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./app-topbar-solid.tsx";
import type { GatewayStatusProps } from "./gateway-status.ts";
import { MacosTitlebarControls } from "./macos-titlebar-controls.runtime-solid.tsx";
import { renderNewSessionLink as NewSessionLink } from "./solid/new-session-link.tsx";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

describe("Solid shell chrome", () => {
  it("updates the topbar's environment and drawer state while retaining its action target", async () => {
    const [environment, setEnvironment] = createSignal<ControlUiEnvironment | null>(null);
    const [open, setOpen] = createSignal(false);
    const [showNewSessionAction, setShowNewSessionAction] = createSignal(false);
    const [gatewayStatus, setGatewayStatus] = createSignal<GatewayStatusProps | null>(null);
    const retry = vi.fn();
    const toggle = vi.fn();
    const palette = vi.fn();
    const openSession = vi.fn();
    const view = mountSolid(() => (
      <openclaw-app-topbar
        prop:environment={environment()}
        prop:navDrawerOpen={open()}
        prop:gatewayStatus={gatewayStatus()}
        prop:newSessionAction={() => (
          <Show when={showNewSessionAction()}>
            <NewSessionLink
              basePath="/control"
              agentId="writer"
              class="header-new-session"
              label="New conversation"
              onOpen={openSession}
            />
          </Show>
        )}
        prop:resourceBasePath="/control"
        prop:onToggleDrawer={toggle}
        prop:onOpenPalette={palette}
      />
    ));
    const topbar = view.container.querySelector<SolidBridgeElement<object>>("openclaw-app-topbar")!;
    const update = async (write: () => void) => {
      write();
      flush();
      await topbar.updateComplete;
    };
    await topbar.updateComplete;
    const drawer = view.container.querySelector<HTMLElement>(".topbar-nav-toggle")!;
    expect(topbar.style.display).toBe("contents");
    expect(view.container.querySelector<HTMLElement>(".control-ui-environment-pill")).toBeNull();
    expect(view.container.querySelector<HTMLElement>("img")?.getAttribute("src")).toBe(
      "/control/apple-touch-icon.png",
    );
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
    drawer.click();
    expect(toggle).toHaveBeenCalledWith(drawer);
    const search = view.container.querySelector<HTMLElement>(".topbar-search")!;
    search.click();
    expect(palette).toHaveBeenCalledOnce();

    await update(() => setGatewayStatus({ kind: "offline", queuedCount: 2, onRetry: retry }));
    const statusLine = view.container.querySelector<HTMLElement>(".mobile-connection-status")!;
    expect(statusLine.textContent).toBe("Disconnected · 2 queued");
    expect(statusLine.querySelector('[role="status"]')).toBeNull();
    expect(drawer.dataset.connectionStatus).toBe("offline");
    expect(drawer.querySelector(".gateway-status-dot")).not.toBeNull();
    statusLine.querySelector<HTMLButtonElement>("button")!.click();
    expect(retry).toHaveBeenCalledOnce();

    await update(() =>
      setGatewayStatus({ kind: "suspended", lastError: "Unavailable?token=mobile-secret" }),
    );
    const status = statusLine.querySelector<HTMLElement>(".gateway-status")!;
    expect(status.tabIndex).toBe(0);
    status.focus();
    expect(document.activeElement).toBe(status);
    expect(
      statusLine.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip")
        ?.content,
    ).toBe("Unavailable?[redacted-credential]");

    await update(() => setGatewayStatus({ kind: "connected" }));
    expect(view.container.querySelector<HTMLElement>(".mobile-connection-status")).toBeNull();
    expect(drawer.dataset.connectionStatus).toBe("connected");

    await update(() => setShowNewSessionAction(true));
    const newSession = view.container.querySelector<HTMLElement>(
      ".topnav-shell__actions .header-new-session",
    )!;
    expect(newSession.getAttribute("href")).toBe("/control/new?agent=writer");
    newSession.click();
    expect(openSession).toHaveBeenCalledWith("writer", undefined);
    newSession.focus();
    await update(() => setEnvironment({ label: "edge", color: "amber" }));
    expect(view.container.querySelector<HTMLElement>(".header-new-session")).toBe(newSession);
    expect(document.activeElement).toBe(newSession);

    await update(() => setShowNewSessionAction(false));
    expect(view.container.querySelector<HTMLElement>(".header-new-session")).toBeNull();
    expect(view.container.querySelector<HTMLElement>(".topbar-search")).toBe(search);

    setEnvironment({ label: "edge", color: "amber" });
    await update(() => setOpen(true));
    expect(
      view.container.querySelector<HTMLElement>(".control-ui-environment-pill")?.textContent,
    ).toBe("edge");
    expect(view.container.querySelector<HTMLElement>(".topbar-nav-toggle")).toBe(drawer);
    expect(drawer.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector<HTMLElement>('[slot="content"] kbd')?.textContent).toBe(
      "⌘K",
    );

    await update(() => setEnvironment(null));
    expect(view.container.querySelector<HTMLElement>(".control-ui-environment-pill")).toBeNull();
  });

  it("releases topbar toggle registrations on repeated mount and unmount", async () => {
    const elements = new RouteElements();
    const [visible, setVisible] = createSignal(false);
    const view = mountSolid(() => (
      <Show when={visible()}>
        <openclaw-app-topbar />
      </Show>
    ));
    view.container.addEventListener("openclaw-route-element", (event) =>
      elements.register(event as RouteElementEvent),
    );
    for (let mount = 0; mount < 2; mount += 1) {
      setVisible(true);
      flush();
      const topbar =
        view.container.querySelector<SolidBridgeElement<object>>("openclaw-app-topbar")!;
      await topbar.updateComplete;
      const toggle = view.container.querySelector<HTMLButtonElement>(".topbar-nav-toggle")!;
      await waitForSolid(() =>
        expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([toggle]),
      );
      setVisible(false);
      flush();
      // Reconnect the retired node so isConnected filtering cannot hide a leaked registration.
      view.container.append(toggle);
      try {
        await waitForSolid(() =>
          expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([]),
        );
      } finally {
        toggle.remove();
      }
    }
  });

  it("retains native history actions across the Settings takeover", () => {
    const [historyOnly, setHistoryOnly] = createSignal(false);
    const [canGoBack, setCanGoBack] = createSignal(false);
    const back = vi.spyOn(globalThis.history, "back").mockImplementation(() => {});
    const view = mountSolid(() => (
      <MacosTitlebarControls
        historyOnly={historyOnly()}
        canGoBack={canGoBack()}
        canGoForward={false}
      />
    ));
    const backButton = view.container.querySelector<HTMLButtonElement>(
      ".macos-titlebar-controls__back",
    )!;
    expect(
      view.container.querySelector<HTMLElement>("openclaw-macos-titlebar-controls")?.style.display,
    ).toBe("contents");
    expect(backButton.disabled).toBe(true);
    expect(view.container.querySelectorAll("button")).toHaveLength(2);
    setCanGoBack(true);
    flush();
    backButton.click();
    expect(back).toHaveBeenCalledOnce();

    setHistoryOnly(true);
    flush();
    expect(view.container.querySelectorAll("button")).toHaveLength(2);
    expect(view.container.querySelector<HTMLElement>(".macos-titlebar-controls__back")).toBe(
      backButton,
    );
    expect(
      view.container.querySelector<HTMLElement>(".macos-titlebar-controls__forward"),
    ).not.toBeNull();
  });
});
