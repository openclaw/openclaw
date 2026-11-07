import { onTestFinished } from "vitest";

/** Call before a fixture mutates document styles so later teardown runs first. */
export function preserveDocumentStyle(): void {
  const root = document.documentElement;
  const style = root.getAttribute("style");
  onTestFinished(() => {
    if (style === null) {
      root.removeAttribute("style");
    } else {
      root.setAttribute("style", style);
    }
  });
}
