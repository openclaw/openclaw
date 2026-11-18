import { describe, expect, it } from "vitest";
import { CONTROL_UI_SETTINGS_PLACES } from "../../../../src/shared/control-ui-settings-places.ts";
import { agentRouteFromPath, routeIdFromPath } from "../../app-route-paths.ts";
import { isAgentsPanel } from "../../lib/agents/panels.ts";
import { configSettingSection } from "../../lib/config-form-utils.ts";
import { CONFIG_PAGE_IDS, configPageForSection } from "./config-sections.ts";
import { AGENT_SETTINGS_TARGET_IDS, MODEL_SETTINGS_TARGET_IDS } from "./route-data.ts";

type Place = { path: string; agent?: true; agentPanel?: string; hash?: string; label: string };
const places: Array<[string, Place]> = Object.entries(CONTROL_UI_SETTINGS_PLACES);
// Rows and blocks that hand-built pages render under these IDs.
const handBuiltTargets: Record<string, ReadonlySet<string>> = {
  "model-providers": new Set(Object.values(MODEL_SETTINGS_TARGET_IDS)),
  agents: new Set(Object.values(AGENT_SETTINGS_TARGET_IDS)),
};

describe("Control UI settings places", () => {
  it.each(places)("%s opens a Settings route that owns its target", (_id, place) => {
    const routeId = routeIdFromPath(place.path);
    expect(routeId, `${place.path} is not a Control UI route`).not.toBeNull();
    if (place.agent) {
      const panel = place.agentPanel ? `/${place.agentPanel}` : "";
      expect(agentRouteFromPath(`${place.path}/main${panel}`)).toMatchObject({
        agentId: "main",
        invalidPanel: false,
      });
      expect(!place.agentPanel || isAgentsPanel(place.agentPanel)).toBe(true);
    }
    if (!place.hash) {
      return;
    }
    const handBuilt = handBuiltTargets[routeId!];
    if (handBuilt) {
      expect(handBuilt.has(place.hash), `${routeId} renders no "${place.hash}"`).toBe(true);
      return;
    }
    // Schema pages render one row per config path; the path's section must live on this page.
    expect(CONFIG_PAGE_IDS).toContain(routeId);
    const section = configSettingSection(place.hash);
    expect(section, `"${place.hash}" is not a setting ID`).not.toBeNull();
    expect(configPageForSection(section!)).toBe(routeId);
  });

  it.each(places)("%s names its place in plain words", (_id, place) => {
    expect(place.label).toMatch(/^Settings > [\x20-\x7E]+$/u);
  });
});
