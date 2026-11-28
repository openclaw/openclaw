import { vi } from "vitest";

export function restoreMocksAndGlobals(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export function mockDocumentVisibility(initial: DocumentVisibilityState = "visible") {
  let visibility = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  return (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}
