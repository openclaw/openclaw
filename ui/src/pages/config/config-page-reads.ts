import type { ApplicationContext } from "../../app/context-types.ts";
import { currentConfigRead, currentDisplayConfig } from "../../lib/config/config-state-model.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";

export function isAppearanceDataTarget(target: string | null) {
  return (
    target === APPEARANCE_SETTINGS_TARGET_IDS.sidebar ||
    target === APPEARANCE_SETTINGS_TARGET_IDS.sessionSources
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

/** The retained page admits editable reads only when its displayed controls need them. */
export function loadConfigPageReads(
  runtimeConfig: ApplicationContext["runtimeConfig"],
  pageId: ConfigPageId,
  section: string | null,
  demand: { data: boolean; importer: boolean; sourceChanged: boolean },
) {
  const config = runtimeConfig.state;
  const displayReady = hasConfigPageDisplay(runtimeConfig, pageId, section);
  if (
    (!displayReady || demand.data || demand.importer) &&
    (demand.sourceChanged ||
      (!config.configSnapshot && !config.configLoading && !currentConfigRead(config)))
  ) {
    void runtimeConfig.ensureLoaded().catch(() => undefined);
  }
  if (
    pageId !== "updates" &&
    (!displayReady || demand.data) &&
    !config.configSchema &&
    !runtimeConfig.schemaRead
  ) {
    void runtimeConfig.ensureSchemaLoaded().catch(() => undefined);
  }
}
