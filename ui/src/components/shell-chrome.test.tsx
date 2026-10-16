import { createSignal, flush, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiEnvironment } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import "./app-topbar-solid.tsx";
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
    const toggle = vi.fn();
    const palette = vi.fn();
    const openSession = vi.fn();
    const view = mountSolid(() => (
      <openclaw-app-topbar
        prop:environment={environment()}
        prop:navDrawerOpen={open()}
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

    setShowNewSessionAction(true);
    flush();
    await topbar.updateComplete;
    const newSession = view.container.querySelector<HTMLAnchorElement>(
      ".topnav-shell__actions .header-new-session",
    )!;
    expect(newSession.getAttribute("href")).toBe("/control/new?agent=writer");
    newSession.click();
    expect(openSession).toHaveBeenCalledWith("writer", undefined);
    newSession.focus();
    setEnvironment({ label: "edge", color: "amber" });
    flush();
    await topbar.updateComplete;
    expect(view.container.querySelector(".header-new-session")).toBe(newSession);
    expect(document.activeElement).toBe(newSession);

    setShowNewSessionAction(false);
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
    expect(view.container.querySelector(".macos-titlebar-controls__back")).toBe(backButton);
    expect(view.container.querySelector(".macos-titlebar-controls__forward")).not.toBeNull();
  });
});
