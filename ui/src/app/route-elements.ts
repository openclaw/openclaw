type RouteElementRegistration = {
  element: HTMLElement;
  key?: string;
  registered: (unregister: () => void) => void;
};

export type RouteElementEvent = CustomEvent<RouteElementRegistration>;

/** Attached elements register with the nearest shell or outlet. */
export function registerRouteElement(element: HTMLElement, key?: string): (() => void) | undefined {
  let unregister: (() => void) | undefined;
  element.dispatchEvent(
    new CustomEvent<RouteElementRegistration>("openclaw-route-element", {
      bubbles: true,
      detail: { element, key, registered: (remove) => (unregister = remove) },
    }),
  );
  return unregister;
}

/** Each shell or outlet owns references to its attached elements, including retained pages. */
export class RouteElements {
  private readonly elements = new Map<string, Set<HTMLElement>>();

  readonly register = (event: RouteElementEvent): void => {
    event.stopPropagation();
    const { element, key, registered } = event.detail;
    const tagName = key ?? element.localName;
    let hosts = this.elements.get(tagName);
    if (!hosts) {
      hosts = new Set();
      this.elements.set(tagName, hosts);
    }
    hosts.add(element);
    registered(() => {
      hosts.delete(element);
      if (hosts.size === 0) {
        this.elements.delete(tagName);
      }
    });
  };

  renderedElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
  ): HTMLElementTagNameMap[K] | undefined;
  renderedElement(tagName: string): HTMLElement | undefined;
  renderedElement(tagName: string): HTMLElement | undefined {
    return this.renderedElements(tagName)[0];
  }

  renderedElements<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K][];
  renderedElements(tagName: string): HTMLElement[];
  renderedElements(tagName: string): HTMLElement[] {
    return [...(this.elements.get(tagName) ?? [])].filter((element) => element.isConnected);
  }
}
