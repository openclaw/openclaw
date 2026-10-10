import { noChange, type ChildPart } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { setCommittedValue } from "lit/directive-helpers.js";
import { directive } from "lit/directive.js";
import type { OpenClawCanvasWidgetView } from "../../../components/canvas-widget-view.ts";

type WidgetProperties = Pick<
  OpenClawCanvasWidgetView,
  | "docId"
  | "sessionKey"
  | "messageTimestamp"
  | "title"
  | "preferredHeight"
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

class CanvasWidgetMountDirective extends AsyncDirective {
  private part?: ChildPart;
  private properties?: WidgetProperties;
  private key = "";
  private element?: OpenClawCanvasWidgetView;
  private placementPending = false;

  render(properties: WidgetProperties) {
    this.properties = properties;
    return noChange;
  }

  override update(part: ChildPart, [properties]: [WidgetProperties]) {
    const key = `${properties.sessionKey}\0${properties.docId}`;
    if (key !== this.key) {
      this.element?.remove();
      this.element = undefined;
      this.key = key;
    }
    this.part = part;
    this.render(properties);
    if (this.element) {
      Object.assign(this.element, properties);
    } else {
      this.placeWhenConnected();
    }
    return noChange;
  }

  private placeWhenConnected(): void {
    // Template updates run in a fragment. Choose the parked view only after
    // insertion, when either repeat commit order has retired the previous row.
    if (typeof Element.prototype.moveBefore === "function" && !this.part?.startNode?.isConnected) {
      if (!this.placementPending) {
        this.placementPending = true;
        queueMicrotask(() => {
          this.placementPending = false;
          if (this.part?.startNode?.isConnected) {
            this.place();
          }
        });
      }
    } else {
      this.place();
    }
  }

  private place(): void {
    const part = this.part;
    const properties = this.properties;
    const parent = part?.startNode?.parentNode;
    if (!this.isConnected || !part || !parent || !properties || this.element) {
      return;
    }
    const parked =
      parent instanceof Element && parent.isConnected && typeof parent.moveBefore === "function"
        ? parkedWidgets.get(this.key)
        : undefined;
    const element = parked?.element ?? document.createElement("openclaw-canvas-widget-view");
    Object.assign(element, properties);
    element.presentationActive = true;
    if (parked && parent instanceof Element) {
      parent.moveBefore(element, part.endNode);
      releaseParking(this.key, parked);
    } else {
      parent.insertBefore(element, part.endNode);
    }
    this.element = element;
    // Placement is manual, but Lit must still clear the range on replacement.
    setCommittedValue(part, element);
  }

  override disconnected(): void {
    const element = this.element;
    if (typeof Element.prototype.moveBefore !== "function" || !element?.isConnected) {
      return;
    }
    const older = parkedWidgets.get(this.key);
    if (older) {
      releaseParking(this.key, older);
    }
    if (!parkingRoot) {
      parkingRoot = document.createElement("div");
      parkingRoot.inert = true;
      parkingRoot.setAttribute("aria-hidden", "true");
      parkingRoot.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none";
      document.body.append(parkingRoot);
    }
    // The light-DOM host is display:contents; the iframe owns its visible box.
    const box = (element.querySelector("iframe") ?? element.parentElement!).getBoundingClientRect();
    const container = document.createElement("div");
    container.style.width = `${box.width}px`;
    container.style.height = `${box.height}px`;
    parkingRoot.append(container);
    element.presentationActive = false;
    container.moveBefore(element, null);
    const key = this.key;
    const parked: ParkedWidget = {
      element,
      container,
      timer: setTimeout(() => releaseParking(key, parked), 1_000),
    };
    parkedWidgets.set(key, parked);
    this.element = undefined;
  }

  override reconnected(): void {
    this.placeWhenConnected();
  }
}

export const canvasWidgetMount = directive(CanvasWidgetMountDirective);
