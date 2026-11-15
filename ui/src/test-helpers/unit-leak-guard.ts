import { vi } from "vitest";
import type { JsdomResourceTracking } from "../../../test/jsdom-resources.ts";

const resourceKey = Symbol.for("openclaw.nonIsolatedDomResourceTracking");

function resources(): JsdomResourceTracking | undefined {
  return (globalThis as typeof globalThis & { [resourceKey]?: JsdomResourceTracking })[resourceKey];
}

function describeNode(node: Node): string {
  if (!(node instanceof Element)) {
    return node.nodeName;
  }
  return `<${node.localName}${node.id ? `#${node.id}` : ""}>`;
}

/** Shallow document state only; mounted trees are retired by cleanupSolid first. */
function beginDocumentLeakCheck() {
  const children = new Set(document.body.childNodes);
  const attributes = [document.body, document.documentElement].map((element) => ({
    element,
    style: element.getAttribute("style") ?? "",
    className: element.getAttribute("class") ?? "",
  }));
  const tracking = resources();
  const listeners = new Set(tracking?.pendingListeners());
  const captures = new Map<number, Element>();
  const captured = (event: Event) => {
    if (event.target instanceof Element) {
      captures.set((event as PointerEvent).pointerId, event.target);
    }
  };
  const released = (event: Event) => captures.delete((event as PointerEvent).pointerId);
  document.addEventListener("gotpointercapture", captured, true);
  document.addEventListener("lostpointercapture", released, true);

  return () => {
    document.removeEventListener("gotpointercapture", captured, true);
    document.removeEventListener("lostpointercapture", released, true);
    const leaks: string[] = [];
    for (const node of document.body.childNodes) {
      if (!children.has(node)) {
        leaks.push(`body child ${describeNode(node)}`);
      }
    }
    for (const { element, style, className } of attributes) {
      const currentStyle = element.getAttribute("style") ?? "";
      const currentClass = element.getAttribute("class") ?? "";
      if (currentStyle !== style) {
        leaks.push(
          `${element.localName} inline style changed: ${JSON.stringify(currentStyle)} (was ${JSON.stringify(style)})`,
        );
      }
      if (currentClass !== className) {
        leaks.push(
          `${element.localName} class changed: ${JSON.stringify(currentClass)} (was ${JSON.stringify(className)})`,
        );
      }
    }
    for (const [id, element] of captures) {
      if (!element.hasPointerCapture || element.hasPointerCapture(id)) {
        leaks.push(`pointer capture ${id} on ${describeNode(element)}`);
      }
    }
    for (const listener of tracking?.pendingListeners() ?? []) {
      if (!listeners.has(listener)) {
        const target =
          listener.target === window
            ? "window"
            : listener.target instanceof Node
              ? describeNode(listener.target)
              : "global";
        leaks.push(`${target} listener ${listener.type}${listener.capture ? " (capture)" : ""}`);
      }
    }
    return leaks;
  };
}

export function beginUiLeakCheck() {
  const fakeTimers = vi.isFakeTimers();
  const checkDocument = typeof document === "undefined" ? undefined : beginDocumentLeakCheck();
  return () => {
    const leaks = checkDocument?.() ?? [];
    if (!fakeTimers && vi.isFakeTimers()) {
      leaks.push("fake timers still installed");
    }
    return leaks;
  };
}

export function reportUiLeaks(test: string, leaks: string[], mode: "report" | "fail" = "report") {
  if (leaks.length === 0) {
    return;
  }
  const message = `[ui-test-leak] ${test}\n${leaks.map((leak) => `  - ${leak}`).join("\n")}`;
  if (mode === "fail") {
    throw new Error(message);
  }
  console.warn(message);
}
