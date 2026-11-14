/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";

const url = "https://example.com/report";
type ClickOptions = MouseEventInit & {
  href?: string;
  attributes?: Record<string, string>;
  enabled?: boolean;
  native?: boolean;
  cancel?: boolean;
};
function click(options: ClickOptions = {}) {
  const postMessage = vi.fn();
  if (options.native) {
    vi.stubGlobal("webkit", {
      messageHandlers: {
        openclawLink: { postMessage },
        openclawBrowser: { postMessage: vi.fn() },
      },
    });
  }
  const anchor = document.createElement("a");
  anchor.href = options.href ?? url;
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    anchor.setAttribute(name, value);
  }
  if (options.cancel) {
    anchor.addEventListener("click", (event) => event.preventDefault());
  }
  const requests: unknown[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent).detail);
  window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
  const routing = startNativeLinkRouting({
    shouldOpenInControlUiBrowser: () => options.enabled !== false,
  });
  const event = new MouseEvent(options.button ? "auxclick" : "click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  document.body.append(anchor);
  try {
    anchor.dispatchEvent(event);
    return { prevented: event.defaultPrevented, requests, postMessage };
  } finally {
    routing.dispose();
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
    anchor.remove();
  }
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  {},
  { metaKey: true },
  { ctrlKey: true },
  { button: 1 },
  { attributes: { target: "_blank" } },
])("routes browser-tab clicks: %j", (options) => {
  const { prevented, requests } = click(options);
  expect({ prevented, requests }).toEqual({ prevented: true, requests: [{ open: true, url }] });
});
const untouched: ClickOptions[] = [
  { enabled: false },
  { cancel: true },
  { href: `${location.origin}/usage` },
  { attributes: { download: "archive.zip" } },
  { attributes: { "data-file-path": "README.md" } },
  { href: "mailto:hello@example.com" },
  { href: "tel:+15555550123" },
  { shiftKey: true },
  { altKey: true },
  { button: 2 },
];
it.each(untouched)("preserves browser/handler ownership: %j", (options) => {
  const { prevented, requests } = click(options);
  expect({ prevented, requests }).toEqual({ prevented: options.cancel === true, requests: [] });
});

it.each([false, true])("native links override remote preference %s", (enabled) => {
  const result = click({ native: true, enabled });
  expect(result.prevented).toBe(true);
  expect(result.postMessage).not.toHaveBeenCalled();
  expect(result.requests).toEqual([{ open: true, url, native: true }]);
});
