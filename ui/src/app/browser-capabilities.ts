/** Required overlay support for the Control UI. */
export function isControlUiBrowserSupported(): boolean {
  const supportsCss = typeof CSS !== "undefined" && typeof CSS.supports === "function";
  return (
    supportsCss &&
    CSS.supports("anchor-name: --a") &&
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function" &&
    typeof HTMLButtonElement !== "undefined" &&
    "commandForElement" in HTMLButtonElement.prototype
  );
}
