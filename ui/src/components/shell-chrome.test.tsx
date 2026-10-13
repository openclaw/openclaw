import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import "./app-topbar.ts";
import { MacosTitlebarControls } from "./macos-titlebar-controls.runtime.ts";
import { renderNewSessionLink } from "./new-session-link.ts";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

describe("Solid shell chrome", () => {
  it("updates the topbar's environment and drawer state while retaining its action target", async () => {
    const [environment, setEnvironment] = createSignal<ControlUiEnvironment | null>(null);
    const [open, setOpen] = createSignal(false);
    const [newSessionAction, setNewSessionAction] = createSignal<unknown>(undefined);
    const toggle = vi.fn();
    const palette = vi.fn();
    const openSession = vi.fn();
    const view = mountSolid(() => (
      <openclaw-app-topbar
        prop:environment={environment()}
        prop:navDrawerOpen={open()}
        prop:newSessionAction={newSessionAction()}
        prop:resourceBasePath="/control"
        prop:onToggleDrawer={toggle}
        prop:onOpenPalette={palette}
      />
    ));
    const topbar = view.container.querySelector<SolidBridgeElement<object>>("openclaw-app-topbar")!;
    await topbar.updateComplete;
    const drawer = view.container.querySelector<HTMLButtonElement>(".topbar-nav-toggle")!;
    expect(view.container.querySelector<HTMLElement>("openclaw-app-topbar")?.style.display).toBe(
      "contents",
    );
    expect(view.container.querySelector(".control-ui-environment-pill")).toBeNull();
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "/control/apple-touch-icon.png",
    );
    expect(drawer.getAttribute("aria-expanded")).toBe("false");
    drawer.click();
    expect(toggle).toHaveBeenCalledWith(drawer);
    const search = view.container.querySelector<HTMLButtonElement>(".topbar-search")!;
    search.click();
    expect(palette).toHaveBeenCalledOnce();

    setNewSessionAction(
      renderNewSessionLink({
        basePath: "/control",
        agentId: "writer",
        className: "header-new-session",
        label: "New conversation",
        onOpen: openSession,
      }),
    );
    flush();
    await topbar.updateComplete;
    const newSession = view.container.querySelector<HTMLAnchorElement>(
      ".topnav-shell__actions .header-new-session",
    )!;
    expect(newSession.getAttribute("href")).toBe("/control/new?agent=writer");
    newSession.click();
    expect(openSession).toHaveBeenCalledWith("writer", undefined);

    setNewSessionAction(undefined);
    flush();
    await topbar.updateComplete;
    expect(view.container.querySelector(".header-new-session")).toBeNull();
    expect(view.container.querySelector(".topbar-search")).toBe(search);

    setEnvironment({ label: "edge", color: "amber" });
    setOpen(true);
    flush();
    await topbar.updateComplete;
    expect(view.container.querySelector(".control-ui-environment-pill")?.textContent).toBe("edge");
    expect(view.container.querySelector(".topbar-nav-toggle")).toBe(drawer);
    expect(drawer.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector('[slot="content"] kbd')?.textContent).toBe("⌘K");

    setEnvironment(null);
    flush();
    await topbar.updateComplete;
    expect(view.container.querySelector(".control-ui-environment-pill")).toBeNull();
  });

  it("updates native navigation, authorization hints, and history-only chrome", () => {
    const [collapsed, setCollapsed] = createSignal(false);
    const [historyOnly, setHistoryOnly] = createSignal(false);
    const [canGoBack, setCanGoBack] = createSignal(false);
    const [reason, setReason] = createSignal<string | undefined>("New sessions are unavailable");
    const openSession = vi.fn();
    const back = vi.spyOn(globalThis.history, "back").mockImplementation(() => {});
    const view = mountSolid(() => (
      <MacosTitlebarControls
        navCollapsed={collapsed()}
        historyOnly={historyOnly()}
        canGoBack={canGoBack()}
        canGoForward={false}
        newSessionDisabledReason={reason()}
        onToggleSidebar={() => setCollapsed((value) => !value)}
        onOpenPalette={() => {}}
        onOpenNewSession={openSession}
      />
    ));
    const backButton = view.container.querySelector<HTMLButtonElement>(
      ".macos-titlebar-controls__back",
    )!;
    expect(
      view.container.querySelector<HTMLElement>("openclaw-macos-titlebar-controls")?.style.display,
    ).toBe("contents");
    expect(backButton.disabled).toBe(true);
    expect(view.container.querySelector(".macos-titlebar-controls__new-session")).toBeNull();
    view.container
      .querySelector<HTMLButtonElement>(".macos-titlebar-controls__sidebar-toggle")!
      .click();
    setCanGoBack(true);
    flush();
    const newSession = view.container.querySelector<HTMLButtonElement>(
      ".macos-titlebar-controls__new-session",
    )!;
    expect(newSession.disabled).toBe(true);
    expect(newSession.closest("openclaw-tooltip")?.content).toBe("New sessions are unavailable");
    expect(newSession.closest("openclaw-tooltip")?.querySelector("kbd")).toBeNull();
    backButton.click();
    expect(back).toHaveBeenCalledOnce();

    setReason(undefined);
    flush();
    expect(newSession.disabled).toBe(false);
    expect(newSession.closest("openclaw-tooltip")?.querySelector("kbd")).not.toBeNull();
    newSession.click();
    expect(openSession).toHaveBeenCalledOnce();

    setHistoryOnly(true);
    flush();
    expect(view.container.querySelectorAll("button")).toHaveLength(2);
    expect(view.container.querySelector(".macos-titlebar-controls__back")).toBe(backButton);
    expect(view.container.querySelector(".macos-titlebar-controls__forward")).not.toBeNull();
  });
});
