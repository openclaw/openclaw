import type { ControlUiSurface } from "../../../src/plugin-sdk/control-ui.js";

export const PLUGIN_SURFACE_PRESENTATION_CHANGED_EVENT =
  "openclaw-plugin-surface-presentation-changed";

type PluginSurfaceElement = HTMLElement & {
  readonly defaultHost?: HTMLElement;
  readonly surface: ControlUiSurface;
  readonly replacesDefault: boolean;
};

export function hasPresentedReplacement(root: HTMLElement, surface: ControlUiSurface): boolean {
  return [...root.querySelectorAll<PluginSurfaceElement>("openclaw-plugin-view")].some(
    (view) => view.defaultHost === root && view.surface === surface && view.replacesDefault,
  );
}
