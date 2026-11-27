import type { ApplicationContext } from "../../app/context-types.ts";
import { currentDisplayConfig } from "../../lib/config/config-state-model.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export function isAppearanceDataTarget(target: string | null) {
  return (
    target === APPEARANCE_SETTINGS_TARGET_IDS.sidebar ||
    target === APPEARANCE_SETTINGS_TARGET_IDS.sessionSources ||
    // Rows in those sections that draw Gateway config, so a link to one can land.
    target === "gateway.controlUi.sessionObserver" ||
    target === "appearance.sessionObserverModel" ||
    target?.startsWith("appearance.sessionSources.") === true
  );
}

export function hasConfigPageDisplay(
  runtimeConfig: ApplicationContext["runtimeConfig"],
  pageId: ConfigPageId,
  section: string | null,
) {
  return (
    pageId === "appearance" &&
    section === "__appearance__" &&
    currentDisplayConfig(runtimeConfig.state) !== null
  );
}
