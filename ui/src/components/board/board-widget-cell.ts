import { ContextNotFoundError } from "@solidjs/signals";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createComponent, merge, onCleanup } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import {
  BoardWidgetCellContents,
  type BoardWidgetCellHandle,
  type BoardWidgetCellProps,
} from "./board-widget-cell.solid.tsx";
export type {
  BoardWidgetCellCallbacks,
  BoardWidgetCellHandle,
  BoardWidgetCellProps,
} from "./board-widget-cell.solid.tsx";

type BoardWidgetCellElement = SolidBridgeElement<BoardWidgetCellProps, BoardWidgetCellHandle>;
const cells = new WeakMap<HTMLElement, BoardWidgetCellHandle>();

function Content(props: BoardWidgetCellProps, host: BoardWidgetCellElement) {
  let context: ApplicationContext | undefined;
  try {
    context = useApplication();
  } catch (error) {
    // Standalone, capless cells do not need an application provider.
    if (!(error instanceof ContextNotFoundError)) {
      throw error;
    }
  }
  Object.defineProperty(host, "presentationReady", {
    configurable: true,
    get: () => cells.get(host)?.presentationReady ?? false,
  });
  onCleanup(() => cells.delete(host));
  return createComponent(
    BoardWidgetCellContents,
    merge(props, {
      host: () => host,
      expose: (handle: BoardWidgetCellHandle) => {
        cells.set(host, handle);
      },
      context,
    }),
  );
}

export const BoardWidgetCell = defineSolidBridge<BoardWidgetCellProps, BoardWidgetCellHandle>(
  "openclaw-board-widget-cell",
  Content,
  {
    properties: {
      widget: { default: undefined, attribute: false },
      rect: { default: undefined, attribute: false },
      contentHeightPx: { default: undefined, attribute: false },
      fitAutoContent: { default: false, type: Boolean },
      pageChrome: { default: false, type: Boolean },
      tabs: { default: [], attribute: false },
      session: { default: { sessionKey: "" }, attribute: false },
      sessionKey: { default: "", attribute: false },
      widgetFrameUrl: { default: undefined, attribute: false },
      callbacks: { default: undefined, attribute: false },
      active: { default: true, type: Boolean },
      bridgeEnabled: { default: true, type: Boolean },
      dragging: { default: false, type: Boolean },
      focusTabIndex: { default: -1, type: Number },
      positionInSet: { default: 1, type: Number },
      setSize: { default: 1, type: Number },
      busy: { default: false, type: Boolean },
      canMutate: { default: true, type: Boolean },
      canGrant: { default: true, type: Boolean },
      loadingCovered: { default: false, type: Boolean },
    },
    methods: {
      selectMenuItem: (host, value) => cells.get(host)?.selectMenuItem(value),
      teardown: async (host) => {
        await cells.get(host)?.teardown();
      },
      restartAfterTeardown: (host) => cells.get(host)?.restartAfterTeardown(),
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-widget-cell": BoardWidgetCellElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-board-widget-cell": SolidJSX.HTMLAttributes<BoardWidgetCellElement> &
        SolidJSX.Properties<BoardWidgetCellElement>;
    }
  }
}
