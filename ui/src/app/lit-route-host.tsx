import type { JSX as SolidJSX } from "@solidjs/web";
import { nothing, render } from "lit";
import { createEffect, onCleanup } from "solid-js";

type LitRouteHostProps = {
  presentation?: boolean;
  presented?: boolean;
  renderValue: () => unknown;
  ref?: (element: HTMLElement) => void;
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-route-presentation": SolidJSX.HTMLAttributes<HTMLElement>;
      "openclaw-route-fragment": SolidJSX.HTMLAttributes<HTMLElement>;
    }
  }
}

/** Temporary renderer island: delete when every route module renders Solid. */
export function LitRouteHost(props: LitRouteHostProps): SolidJSX.Element {
  let host!: HTMLElement;
  const bind = (element: HTMLElement) => {
    host = element;
    props.ref?.(element);
  };
  createEffect(
    () => props.renderValue(),
    (value) => {
      render(value, host, { host });
    },
  );
  onCleanup(() => render(nothing, host));
  return (
    <>
      {props.presentation ? (
        <openclaw-route-presentation
          ref={bind}
          style={{ display: props.presented ? "contents" : "none" }}
          hidden={!props.presented}
          inert={!props.presented}
          aria-hidden={props.presented ? "false" : "true"}
        />
      ) : (
        <openclaw-route-fragment ref={bind} style={{ display: "contents" }} />
      )}
    </>
  );
}
