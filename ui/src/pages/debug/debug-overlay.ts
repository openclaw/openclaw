import { createComponent } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import type { DebugOverlayMode } from "./debug-overlay-state.ts";
import { DebugOverlayView } from "./debug-overlay-view.tsx";

type Props = {
  context: ApplicationContext | undefined;
  mode: DebugOverlayMode | "closed";
  contentKey: number;
};
type Methods = {
  open(mode: DebugOverlayMode): void;
  toggle(): void;
};

export const DebugOverlay = defineSolidBridge<Props, Methods>(
  "openclaw-debug-overlay",
  (props, host) => {
    const inherited = props.context ? undefined : useApplication();
    return createComponent(DebugOverlayView, {
      get context() {
        return props.context ?? inherited;
      },
      host,
      get mode() {
        return props.mode;
      },
      get contentKey() {
        return props.contentKey;
      },
      onClose: () => {
        host.mode = "closed";
      },
      onToggleMode: () => {
        host.mode = host.mode === "minimized" ? "expanded" : "minimized";
      },
      onDisconnect: () => {
        if (!host.isConnected) {
          host.mode = "closed";
        }
      },
    });
  },
  {
    properties: {
      context: { default: undefined, attribute: false },
      mode: { default: "closed", attribute: false },
      contentKey: { default: 0, attribute: false },
    },
    methods: {
      open: (host, mode) => {
        if (host.mode === "closed") {
          host.contentKey += 1;
        }
        host.mode = mode;
      },
      toggle: (host) => {
        if (host.mode === "expanded") {
          host.mode = "closed";
        } else {
          host.open("expanded");
        }
      },
    },
  },
);
