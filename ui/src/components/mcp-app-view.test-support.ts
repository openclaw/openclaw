import { createComponent } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import type { McpAppViewElement } from "./mcp-app-view-controller.ts";

const { McpAppView } = await import("./mcp-app-view.tsx");

export function mountView(props: Parameters<typeof McpAppView>[0], context: object = {}) {
  const supplied = context as Partial<ApplicationContext>;
  const provider = createSolidApplicationContextProvider({
    ...supplied,
    gateway: {
      subscribe: () => () => {},
      snapshot: { client: null, phase: "stopped" },
      ...supplied.gateway,
    },
  } as ApplicationContext);
  const mounted = mountSolid(() => createComponent(McpAppView, props), {
    wrapper: provider.wrapper,
  });
  return { ...mounted, view: mounted.container.querySelector<McpAppViewElement>("mcp-app-view")! };
}
