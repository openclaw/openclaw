import { vi } from "vitest";

export function installLogsViewport() {
  // jsdom has no layout; browser scenarios own native positioning proof.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("log-stream")
      ? 440
      : this.classList.contains("log-row")
        ? 44
        : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
}
