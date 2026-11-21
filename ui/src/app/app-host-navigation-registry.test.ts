/* @vitest-environment jsdom */
import { render } from "@solidjs/testing-library";
import { createComponent, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { OpenClawShell, ShellOwner } from "./app-host.tsx";
import { bootstrapApplication } from "./bootstrap.ts";
import { RouterOutlet } from "./router-outlet.tsx";

afterEach(resetAppHostTestGlobals);

it("registers, dismisses, and retires shell and route attention hosts", async () => {
  const { SidebarAttention } = await import("../components/sidebar-attention.tsx");
  vi.stubGlobal("requestIdleCallback", vi.fn());
  const runtime = bootstrapApplication();
  const shellAttention = new SidebarAttention.Element();
  const routeAttention = new SidebarAttention.Element();
  let owner: ShellOwner | undefined;
  let routeView: ReturnType<typeof render> | undefined;
  const view = render(() =>
    createComponent(OpenClawShell, {
      runtime,
      onShell(shell) {
        owner = shell instanceof ShellOwner ? shell : undefined;
      },
    }),
  );
  try {
    flush();
    if (!owner) {
      throw new Error("Shell owner did not mount");
    }
    const shell = owner;
    const routeContainer = document.createElement("div");
    shell.element.append(shellAttention, routeContainer);
    routeView = render(
      () => createComponent(RouterOutlet, { ref: (outlet) => (shell.routeOutlet = outlet) }),
      { container: routeContainer },
    );
    flush();
    shell.routeOutlet!.append(routeAttention);

    expect(shell.renderedShellElements.renderedElements("openclaw-sidebar-attention")).toEqual([
      shellAttention,
    ]);
    expect(shell.routeOutlet!.renderedElements?.("openclaw-sidebar-attention")).toEqual([
      routeAttention,
    ]);
    expect(shell.queryRenderedElements("openclaw-sidebar-attention")).toEqual([
      shellAttention,
      routeAttention,
    ]);
    expect(shell.queryRenderedElement("openclaw-sidebar-attention")).toBe(shellAttention);
    const dismissShell = vi.spyOn(shellAttention, "dismissPanel").mockReturnValue(true);
    const dismissRoute = vi.spyOn(routeAttention, "dismissPanel").mockReturnValue(false);
    shell.navDrawerOpen = true;
    shell.closeNavDrawer();
    expect(dismissShell).toHaveBeenCalledOnce();
    expect(dismissRoute).toHaveBeenCalledOnce();
    expect(shell.navDrawerOpen).toBe(false);

    // Reconnect outside the registry so connection filtering cannot hide a leaked entry.
    routeAttention.remove();
    document.body.append(routeAttention);
    expect(shell.queryRenderedElements("openclaw-sidebar-attention")).toEqual([shellAttention]);
    shell.navDrawerOpen = true;
    shell.closeNavDrawer();
    expect(dismissShell).toHaveBeenCalledTimes(2);
    expect(dismissRoute).toHaveBeenCalledOnce();

    shellAttention.remove();
    document.body.append(shellAttention);
    expect(shell.queryRenderedElements("openclaw-sidebar-attention")).toEqual([]);
    expect(shell.queryRenderedElement("openclaw-sidebar-attention")).toBeNull();
    shell.navDrawerOpen = true;
    shell.closeNavDrawer();
    expect(dismissShell).toHaveBeenCalledTimes(2);
    expect(dismissRoute).toHaveBeenCalledOnce();
  } finally {
    shellAttention.remove();
    routeAttention.remove();
    routeView?.unmount();
    view.unmount();
    runtime.stop();
  }
});
