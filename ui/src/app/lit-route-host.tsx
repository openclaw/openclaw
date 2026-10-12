import type { JSX as SolidJSX } from "@solidjs/web";
import { createLitContentRef } from "../lit/solid-bridge.ts";

type LitRouteHostProps = {
  presentation?: boolean;
  presented?: boolean;
  renderValue: () => unknown;
  ref?: (element: HTMLElement) => void;
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-route-presentation": HTMLAttributes<HTMLElement>;
      "openclaw-route-fragment": HTMLAttributes<HTMLElement>;
    }
  }
}

/** Temporary renderer island: delete when every route module renders Solid. */
export function LitRouteHost(props: LitRouteHostProps): SolidJSX.Element {
  const contentRef = createLitContentRef(() => props.renderValue());
  const bind = (element: HTMLElement) => {
    contentRef(element);
    props.ref?.(element);
  };
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
