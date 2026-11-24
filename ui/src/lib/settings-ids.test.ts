import { describe, expect, it } from "vitest";
import { CONTROL_UI_SETTINGS_PAGES } from "../../../src/shared/control-ui-settings/index.ts";
import { isSettingsNavigationRouteVisible } from "../app-navigation.ts";
import { agentRouteFromPath, routeIdFromPath } from "../app-route-paths.ts";

describe("Control UI settings pages", () => {
  it.each(CONTROL_UI_SETTINGS_PAGES.map((page) => [page.path, page] as const))(
    "%s is a Settings route",
    (_path, page) => {
      const routeId = routeIdFromPath(page.path);
      expect(routeId).not.toBeNull();
      expect(isSettingsNavigationRouteVisible(routeId!, true)).toBe(true);
      if (page.agent) {
        const panel = page.agentPanel ? `/${page.agentPanel}` : "";
        expect(agentRouteFromPath(`${page.path}/main${panel}`)).toMatchObject({
          agentId: "main",
          invalidPanel: false,
        });
      }
    },
  );
});
