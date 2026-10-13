import type { ApplicationTheme } from "../../app/context-types.ts";
import { projectSource } from "./projection.ts";

/** Preferences publish immediately; palette facts publish only after application. */
export function projectTheme(theme: ApplicationTheme) {
  const preferences = projectSource(theme, {
    read: (source) => source.settings,
    subscribe: (source, notify) => source.subscribe(notify),
    equality: Object.is,
  });
  const appliedPalette = projectSource(theme, {
    read: (source) => source.appliedPalette,
    subscribe: (source, notify) => source.subscribe(notify),
    equality: Object.is,
  });
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
