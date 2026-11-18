import { render } from "@solidjs/testing-library";
import { createComponent, createRoot, flush, onSettled } from "solid-js";
import { onTestFinished, vi } from "vitest";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import { ShellOwner } from "./app-host.tsx";
import { ApplicationShell } from "./app-shell-view.tsx";
import { bootstrapApplication } from "./bootstrap.ts";

export async function mountShell(waitForSidebar = true) {
  const runtime = bootstrapApplication();
  const { owner, dispose } = createRoot((disposeRoot) => ({
    owner: new ShellOwner(document.createElement("openclaw-app-shell"), runtime),
    dispose: disposeRoot,
  }));
  owner.routeState = { routeId: "chat" };
  document.body.append(owner.element);
  const view = render(
    () => {
      onSettled(() => owner.mountPresentation());
      return createComponent(ApplicationProvider, {
        host: owner.element,
        value: runtime.context,
        get children() {
          return createComponent(ApplicationShell, { host: owner });
        },
      });
    },
    {
      container: owner.element,
    },
  );
  onTestFinished(() => {
    view.unmount();
    owner.disconnect();
    dispose();
    runtime.stop();
  });
  await Promise.resolve();
  if (waitForSidebar) {
    await vi.dynamicImportSettled();
  }
  flush();
  const refresh = () => {
    owner.invalidate();
    flush();
  };
  const query: typeof view.container.querySelector = view.container.querySelector.bind(
    view.container,
  );
  const settle = async (withTopbar = false) => {
    refresh();
    await owner.navigationSidebar.updateComplete;
    if (withTopbar) {
      await query<SolidBridgeElement<object>>("openclaw-app-topbar")!.updateComplete;
    }
    flush();
  };
  const route = (routeId: NonNullable<ShellOwner["routeState"]["routeId"]>) => {
    owner.routeState = { routeId };
    refresh();
  };
  const gateway = () => {
    const initial = runtime.context.gateway.snapshot;
    const snapshot = vi.spyOn(runtime.context.gateway, "snapshot", "get");
    return (patch: Partial<typeof initial>) => snapshot.mockReturnValue({ ...initial, ...patch });
  };
  return { owner, runtime, view, query, refresh, settle, route, gateway };
}
