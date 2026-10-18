import { createEffect, createMemo, onCleanup, onSettled, Show, useContext } from "solid-js";
import type { OpenClawCanvasWidgetView } from "../../../components/canvas-widget-view.tsx";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";

type WidgetProperties = Pick<
  OpenClawCanvasWidgetView,
  | "docId"
  | "sessionKey"
  | "messageTimestamp"
  | "title"
  | "preferredHeight"
  | "onHeightChange"
  | "allowScripts"
  | "connectionGeneration"
>;
type ParkedWidget = {
  element: OpenClawCanvasWidgetView;
  container: HTMLDivElement;
  timer: ReturnType<typeof setTimeout>;
};

const parkedWidgets = new Map<string, ParkedWidget>();
let parkingRoot: HTMLDivElement | undefined;

function releaseParking(key: string, parked: ParkedWidget): void {
  clearTimeout(parked.timer);
  parkedWidgets.delete(key);
  parked.container.remove();
  if (!parkingRoot?.childElementCount) {
    parkingRoot?.remove();
    parkingRoot = undefined;
  }
}

function CanvasWidgetHost(props: { properties: WidgetProperties; widgetKey: string }) {
  const presented = useContext(ContentPresentation);
  let container!: HTMLSpanElement;
  let element: OpenClawCanvasWidgetView | undefined;
  createEffect(
    () => ({ properties: { ...props.properties }, active: presented() }),
    ({ properties, active }) => {
      if (element) {
        Object.assign(element, properties, { presentationActive: active });
      }
    },
  );
  onSettled(() => {
    const parked =
      container.isConnected && typeof container.moveBefore === "function"
        ? parkedWidgets.get(props.widgetKey)
        : undefined;
    const view = parked?.element ?? document.createElement("openclaw-canvas-widget-view");
    Object.assign(view, props.properties);
    if (!customElements.get("openclaw-canvas-widget-view")) {
      view.style.cssText = `display:block;min-height:${props.properties.preferredHeight ?? 420}px`;
    }
    view.presentationActive = presented();
    if (parked) {
      container.moveBefore(view, null);
      releaseParking(props.widgetKey, parked);
    } else {
      container.append(view);
    }
    element = view;
  });
  onCleanup(() => {
    const view = element;
    if (typeof Element.prototype.moveBefore !== "function" || !view?.isConnected) {
      return;
    }
    const key = props.widgetKey;
    const older = parkedWidgets.get(key);
    if (older) {
      releaseParking(key, older);
    }
    if (!parkingRoot) {
      parkingRoot = document.createElement("div");
      parkingRoot.inert = true;
      parkingRoot.setAttribute("aria-hidden", "true");
      parkingRoot.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none";
      document.body.append(parkingRoot);
    }
    // Atomic moves retain the iframe while its transcript row changes identity.
    const box = (view.querySelector("iframe") ?? container).getBoundingClientRect();
    const parkedContainer = document.createElement("div");
    parkedContainer.style.width = `${box.width}px`;
    parkedContainer.style.height = `${box.height}px`;
    parkingRoot.append(parkedContainer);
    view.presentationActive = false;
    parkedContainer.moveBefore(view, null);
    const parked: ParkedWidget = {
      element: view,
      container: parkedContainer,
      timer: setTimeout(() => releaseParking(key, parked), 1_000),
    };
    parkedWidgets.set(key, parked);
  });
  return (
    <span
      ref={(node) => {
        container = node;
      }}
      style={{ display: "contents" }}
    />
  );
}

export function CanvasWidgetMount(props: WidgetProperties) {
  const key = createMemo(() => `${props.sessionKey}\0${props.docId}`);
  return (
    <Show when={key()} keyed>
      {(widgetKey) => <CanvasWidgetHost properties={props} widgetKey={widgetKey} />}
    </Show>
  );
}
