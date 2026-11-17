import { CONTROL_UI_BROWSER_REQUIREMENTS } from "../../../src/shared/control-ui-browser-requirements.js";

/** Browser-side feature probes remain authoritative over installed-version estimates. */
export function isControlUiBrowserSupported(): boolean {
  return CONTROL_UI_BROWSER_REQUIREMENTS.every((requirement) =>
    requirement.kind === "css"
      ? typeof CSS !== "undefined" &&
        typeof CSS.supports === "function" &&
        CSS.supports(requirement.feature)
      : typeof HTMLElement !== "undefined" &&
        typeof HTMLElement.prototype[requirement.feature] === "function",
  );
}
