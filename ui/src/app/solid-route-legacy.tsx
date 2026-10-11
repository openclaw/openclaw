import type { JSX } from "@solidjs/web";
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
  const owner = shellLayoutOwnerForHost(props.host);
  return (
    <ApplicationProvider value={props.context!}>
      <ShellLayoutProvider value={owner ? { owner, host: props.host } : null}>
        <SolidRouteContent {...props} />
      </ShellLayoutProvider>
    </ApplicationProvider>
  );
}

// Remove with the Lit outlet when SHELL lands; native pages already share this component API.
export function renderSolidRoute(props: LegacyRouteProps) {
  return solidContent(LegacyRoute, props);
}
