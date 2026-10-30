import { onTestFinished, vi } from "vitest";

let installed = false;

/** jsdom has no layout; browser tests own real picker measurement and scrolling. */
export function installModelPickerLayout() {
  if (installed) {
    return;
  }
  installed = true;
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
  const heightMock = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("chat-controls__model-virtual-row")
        ? 32
        : height.get!.call(this);
    });
  // Virtual-core observes the viewport client box but measures row border boxes.
  const clientHeightMock = vi
    .spyOn(Element.prototype, "clientHeight", "get")
    .mockImplementation(function (this: Element) {
      return this.hasAttribute("data-chat-model-window") ? 320 : clientHeight.get!.call(this);
    });
  const widthMock = vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (
    this: Element,
  ) {
    return this.hasAttribute("data-chat-model-window") ? 340 : clientWidth.get!.call(this);
  });
  onTestFinished(() => {
    installed = false;
    heightMock.mockRestore();
    clientHeightMock.mockRestore();
    widthMock.mockRestore();
  });
}
