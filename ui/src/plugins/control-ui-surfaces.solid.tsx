import type { JSX } from "@solidjs/web";
import { lazy, Show, useContext } from "solid-js";
import type {
  ControlUiSurface,
  ControlUiSurfaceProps,
} from "../../../src/plugin-sdk/control-ui.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { sharedPluginsProjection } from "../lib/reactive/shared-application-projections.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import { ControlUiLazyView } from "./control-ui-lazy-view.tsx";

const SelectedPluginSurface = lazy(() => import("./control-ui-view.solid.tsx"), {
  export: "SelectedPluginSurface",
});

export function PluginSurface<S extends ControlUiSurface>(props: {
  surface: S;
  props: ControlUiSurfaceProps[S];
  renderDefault: () => JSX.Element;
  renderCompanion?: () => JSX.Element;
  presented?: boolean;
  enabled?: boolean;
  replacementRef?: (element: HTMLElement) => void | (() => void);
}) {
  const context = useOptionalApplication();
  const runtime = context && sharedPluginsProjection(context.plugins);
  const contentPresented = useContext(ContentPresentation);
  const presented = () => (props.presented ?? true) && contentPresented();
  const selected = createParkedProjection(
    () =>
      props.enabled === false ? undefined : runtime?.read().selectedReplacement(props.surface),
    presented,
  );
  return (
    <Show when={selected()} fallback={props.renderDefault()}>
      <ControlUiLazyView fallback={props.renderDefault}>
        <SelectedPluginSurface {...props} />
      </ControlUiLazyView>
    </Show>
  );
}
