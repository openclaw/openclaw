/** Required overlay support and optional input autosizing for the Solid cutover. */
export function detectControlUiBrowserCapabilities(): { supported: boolean; fieldSizing: boolean } {
  const supportsCss = typeof CSS !== "undefined" && typeof CSS.supports === "function";
  return {
    supported:
      supportsCss &&
      CSS.supports("anchor-name: --a") &&
      typeof HTMLElement !== "undefined" &&
      typeof HTMLElement.prototype.showPopover === "function" &&
      typeof HTMLButtonElement !== "undefined" &&
      "commandForElement" in HTMLButtonElement.prototype,
    fieldSizing: supportsCss && CSS.supports("field-sizing: content"),
  };
}
