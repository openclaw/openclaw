import { spread } from "@solidjs/web";
import { createMemo, createSignal, omit, onSettled, Show, useContext } from "solid-js";
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
type CanvasWidgetMountProps = WidgetProperties & {
  onElement?: (element: OpenClawCanvasWidgetView | undefined) => void;
};
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

function CanvasWidgetHost(props: {
  properties: WidgetProperties;
  widgetKey: string;
  onElement: CanvasWidgetMountProps["onElement"];
}) {
  const presented = useContext(ContentPresentation);
  let container!: HTMLSpanElement;
  const [element, setElement] = createSignal<OpenClawCanvasWidgetView>();
  onSettled(() => {
    const onElement = props.onElement;
    const retained =
      container.isConnected && typeof container.moveBefore === "function"
        ? parkedWidgets.get(props.widgetKey)
        : undefined;
    const view = retained?.element ?? document.createElement("openclaw-canvas-widget-view");
    Object.assign(view, props.properties);
    if (!customElements.get("openclaw-canvas-widget-view")) {
      view.style.cssText = `display:block;min-height:${props.properties.preferredHeight ?? 420}px`;
    }
    view.presentationActive = presented();
    if (retained) {
      container.moveBefore(view, null);
      releaseParking(props.widgetKey, retained);
    } else {
      container.append(view);
    }
    setElement(view);
    onElement?.(view);
    return () => {
      onElement?.(undefined);
      if (typeof Element.prototype.moveBefore !== "function" || !view.isConnected) {
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
      const box = (view.previewFrame ?? container).getBoundingClientRect();
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
    };
  });
  return (
    <span
      ref={(node) => {
        container = node;
      }}
      style={{ display: "contents" }}
    >
      <Show when={element()} keyed>
        {(view) => {
          // Bind after adoption so an outgoing row can park its existing widget first.
          spread(
            view,
            () => ({
              "prop:docId": props.properties.docId,
              "prop:sessionKey": props.properties.sessionKey,
              "prop:messageTimestamp": props.properties.messageTimestamp,
              "prop:title": props.properties.title,
              "prop:preferredHeight": props.properties.preferredHeight,
              "prop:onHeightChange": props.properties.onHeightChange,
              "prop:allowScripts": props.properties.allowScripts,
              "prop:connectionGeneration": props.properties.connectionGeneration,
              "prop:presentationActive": presented(),
            }),
            true,
          );
          return null;
        }}
      </Show>
    </span>
  );
}

export function CanvasWidgetMount(props: CanvasWidgetMountProps) {
  const properties = omit(props, "onElement");
  const key = createMemo(() => `${props.sessionKey}\0${props.docId}`);
  return (
    <Show when={key()} keyed>
      {(widgetKey) => (
        <CanvasWidgetHost
          properties={properties}
          widgetKey={widgetKey}
          onElement={props.onElement}
        />
      )}
    </Show>
  );
}
