import { Show, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { DebugOverlayContent as Content } from "./debug-overlay-content-view.tsx";

type Props = { context: ApplicationContext | undefined; minimized: boolean };

export const DebugOverlayContent = defineSolidBridge<Props>(
  "openclaw-debug-overlay-content",
  (props) => {
    const inherited = untrack(() => props.context) ? undefined : useApplication();
    return (
      <Show when={props.context ?? inherited} keyed>
        {(context) => <Content context={context} minimized={props.minimized} />}
      </Show>
    );
  },
  {
    properties: {
      context: { default: undefined, attribute: false },
      minimized: { default: false, type: Boolean },
    },
  },
);
