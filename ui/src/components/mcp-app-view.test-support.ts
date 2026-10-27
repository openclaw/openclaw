import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import type { McpAppViewElement } from "./mcp-app-view-types.ts";

const { McpAppView } = await import("./mcp-app-view.tsx");

export function mountView(props: Parameters<typeof McpAppView>[0], context: object = {}) {
  const supplied = context as Partial<ApplicationContext>;
  const provider = createSolidApplicationContextProvider({
    ...supplied,
    gateway: {
      subscribe: () => () => {},
      ...supplied.gateway,
      get connectionRevision() {
        return supplied.gateway?.connectionRevision ?? 0;
      },
      get snapshot() {
        return supplied.gateway?.snapshot ?? { client: null, phase: "stopped", hello: null };
      },
    },
  } as ApplicationContext);
  const mounted = mountSolid(() => createComponent(McpAppView, props), {
    wrapper: provider.wrapper,
  });
  return { ...mounted, view: mounted.container.querySelector<McpAppViewElement>("mcp-app-view")! };
}

export function mockMcpSandboxProxyReady() {
  vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window);
  const frameSource = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")!;
  vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(function (
    this: HTMLIFrameElement,
    value,
  ) {
    frameSource.set!.call(this, value);
    queueMicrotask(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { method: "ui/notifications/sandbox-proxy-ready" },
        }),
      ),
    );
  });
}
