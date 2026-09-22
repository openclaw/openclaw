import { expect, it } from "vitest";
import { installedPluginDetailTabFromHash, pluginDetailLocation } from "./detail-tabs.ts";

it("keeps the configuration deep link while former overview tabs use the overview", () => {
  expect(installedPluginDetailTabFromHash("#configuration")).toBe("configuration");
  expect(installedPluginDetailTabFromHash("#skills")).toBe("readme");
  expect(installedPluginDetailTabFromHash("#not-a-plugin-tab")).toBe("readme");
});

it("keeps catalog identity and breadcrumb query when entering and leaving Settings", () => {
  const location = { pathname: "/plugins/ch_demo", search: "?from=plugins" };
  const settings = pluginDetailLocation(location, true);
  expect(settings).toEqual({ ...location, search: "?from=plugins&view=settings", hash: "" });
  expect(pluginDetailLocation({ ...settings, pathname: location.pathname }, false)).toEqual({
    ...location,
    hash: "",
  });
});
