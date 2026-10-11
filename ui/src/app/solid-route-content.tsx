import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { SolidRouteProps } from "../app-routes.ts";

/** Loader updates change props without recreating the page's local state. */
export function SolidRouteContent(
  props: SolidRouteProps & { render: (props: SolidRouteProps) => JSX.Element },
) {
  return (
    <Show when={props.render} keyed>
      {(View) => (
        <View data={props.data} loaderPending={props.loaderPending} presented={props.presented} />
      )}
    </Show>
  );
}
