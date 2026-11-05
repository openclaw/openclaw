import type { ApplicationTheme } from "../../app/context-types.ts";
import { projectOwner } from "./projection.ts";

/** Preferences publish immediately; palette facts publish only after application. */
export function projectTheme(theme: ApplicationTheme) {
  const preferences = projectOwner(theme, (source) => source.settings, Object.is);
  const appliedPalette = projectOwner(theme, (source) => source.appliedPalette, Object.is);
  return {
    preferences,
    appliedPalette,
    replaceSource(this: void, source: ApplicationTheme) {
      preferences.replaceSource(source);
      appliedPalette.replaceSource(source);
    },
    dispose(this: void) {
      preferences.dispose();
      appliedPalette.dispose();
    },
  };
}
