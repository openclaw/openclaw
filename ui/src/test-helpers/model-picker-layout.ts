import { onTestFinished, vi } from "vitest";

let installed = false;

/** jsdom has no layout; browser tests own real picker measurement and scrolling. */
export function installModelPickerLayout() {
  if (installed) {
    return;
  }
  installed = true;
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  const heightMock = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-chat-model-window")) {
        return 320;
      }
      return this.classList.contains("chat-controls__model-virtual-row")
        ? 32
        : height.get!.call(this);
    });
  const widthMock = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-chat-model-window") ? 340 : width.get!.call(this);
    });
  onTestFinished(() => {
    installed = false;
    heightMock.mockRestore();
    widthMock.mockRestore();
  });
}
