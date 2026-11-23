import type { JSX } from "@solidjs/web";
import { lazy, Show, useContext } from "solid-js";
import type {
  ControlUiSurface,
  ControlUiSurfaceProps,
} from "../../../src/plugin-sdk/control-ui.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import type { ViewKind } from "./control-ui-view.solid.tsx";

export const PluginView = lazy(() => import("./control-ui-view.solid.tsx"), {
  export: "PluginView",
});
const PluginReplacement = lazy(() => import("./control-ui-view.solid.tsx"), {
  export: "PluginReplacement",
});

// Resolve native views before activation can publish registrations.
export async function preloadNativeViews() {
  await Promise.all([PluginView.preload(), PluginReplacement.preload()]);
}

export type PluginSurfaceProps<S extends ControlUiSurface> = {
  surface: S;
  props: ControlUiSurfaceProps[S];
  renderDefault: () => JSX.Element;
  renderCompanion?: () => JSX.Element;
  presented?: boolean;
  enabled?: boolean;
  replacementRef?: (element: HTMLElement) => void | (() => void);
};

export function PluginSurface<S extends ControlUiSurface>(props: PluginSurfaceProps<S>) {
  const context = useOptionalApplication();
  const runtime = context && projectOwner(context.plugins, (source) => source);
  const contentPresented = useContext(ContentPresentation);
  const presented = () => (props.presented ?? true) && contentPresented();
  const selected = createParkedProjection(
    () =>
      props.enabled === false ? undefined : runtime?.read().selectedReplacement(props.surface),
    presented,
  );
  return (
    <Show when={selected()} fallback={props.renderDefault()}>
      <PluginReplacement {...props} presented={presented()} />
    </Show>
  );
}

export function PluginContribution(props: {
  kind: Exclude<ViewKind, "replacements">;
  contributionKey: string;
  props: unknown;
  presented?: boolean;
  fallback?: () => JSX.Element;
}) {
  return (
    <PluginView
      kind={props.kind}
      fallback={props.fallback}
      contributionKey={props.contributionKey}
      props={props.props}
      presented={props.presented ?? true}
    />
  );
}
