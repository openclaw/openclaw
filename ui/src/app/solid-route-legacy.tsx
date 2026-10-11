import type { JSX } from "@solidjs/web";
import { Show, untrack } from "solid-js";
import type { SolidRouteProps } from "../app-routes.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { solidContent } from "../lit/solid-content.tsx";
import type { ApplicationContext } from "./context.ts";
import { shellLayoutOwnerForHost } from "./shell-layout-owner.ts";
import { ShellLayoutProvider } from "./shell-layout-traits-solid.tsx";
import { SolidRouteContent } from "./solid-route-content.tsx";

type LegacyRouteProps = SolidRouteProps & {
  render: (props: SolidRouteProps) => JSX.Element;
  context: ApplicationContext | undefined;
  host: Element;
};

function LegacyRoute(props: LegacyRouteProps) {
  const host = untrack(() => props.host);
  const owner = shellLayoutOwnerForHost(host);
  return (
    <Show when={props.context} keyed>
      {(context) => (
        <ApplicationProvider value={context}>
          <ShellLayoutProvider value={owner ? { owner, host } : null}>
            <SolidRouteContent {...props} />
          </ShellLayoutProvider>
        </ApplicationProvider>
      )}
    </Show>
  );
}

// Remove with the Lit outlet when SHELL lands; native pages already share this component API.
export function renderSolidRoute(props: LegacyRouteProps) {
  return solidContent(LegacyRoute, props);
}
