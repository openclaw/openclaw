/** Feature admission and conservative installed-version estimates share these requirements.
 * Version floors: MDN browser-compat-data css.properties.anchor-name and
 * api.HTMLElement.showPopover. Estimates never replace browser-side probes.
 */
export const CONTROL_UI_BROWSER_REQUIREMENTS = [
  {
    kind: "css",
    feature: "anchor-name: --a",
    minimumVersions: { chrome: 125, edge: 125, firefox: 147, safari: 26 },
  },
  {
    kind: "element-method",
    feature: "showPopover",
    minimumVersions: { chrome: 114, edge: 114, firefox: 125, safari: 17 },
  },
] as const;

export type ControlUiBrowserFamily =
  | keyof (typeof CONTROL_UI_BROWSER_REQUIREMENTS)[number]["minimumVersions"]
  | "ie";

export function estimateControlUiBrowserSupport(
  family: ControlUiBrowserFamily,
  version: string,
): "compatible" | "unsupported" | "unknown" {
  if (family === "ie") {
    return "unsupported";
  }
  const major = Number(version.split(".")[0]);
  if (!/^\d+(?:\.\d+)*$/.test(version) || !Number.isSafeInteger(major) || major <= 0) {
    return "unknown";
  }
  return CONTROL_UI_BROWSER_REQUIREMENTS.every(
    (requirement) => major >= requirement.minimumVersions[family],
  )
    ? "compatible"
    : "unsupported";
}
