import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalPluginTabLocation,
  INTERNAL_PLUGIN_PATH_PARAM,
  pluginTabLocation,
  pluginSlugCandidate,
  pluginTabSlugFromPath,
  routeIdFromPath,
  setPluginTabSlugs,
} from "../../app-route-paths.ts";
import { pluginTabRefFromSearch } from "./route.ts";

const ref = { pluginId: "reports-fixture", id: "summary" };
const tab = { ...ref, slug: "reports" };
afterEach(() => {
  setPluginTabSlugs();
  vi.restoreAllMocks();
});

describe("plugin tab addresses", () => {
  it("resolves mounted slug paths and withdraws routes with the next hello", () => {
    setPluginTabSlugs([tab]);
    expect(routeIdFromPath("/ui/reports", "/ui")).toBe("plugin");
    expect(pluginTabSlugFromPath("/ui/reports/", "/ui")).toEqual(tab);
    expect(pluginTabSlugFromPath("/other/reports", "/ui")).toBeNull();
    expect(pluginTabSlugFromPath("/ui/reports/nested", "/ui")).toBeNull();
    expect(pluginTabRefFromSearch("?p.range=week", "/ui/reports", "/ui")).toEqual(ref);
    expect(
      pluginTabRefFromSearch(`?${INTERNAL_PLUGIN_PATH_PARAM}=%2Fui%2Freports`, "/ui/plugin", "/ui"),
    ).toEqual(ref);
    setPluginTabSlugs([]);
    expect(routeIdFromPath("/ui/reports", "/ui")).toBeNull();
  });

  it.each(["settings", "config", "skills", "chat"])(
    "keeps native %s routes and aliases in charge",
    (slug) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const collision = { ...tab, slug };
      setPluginTabSlugs([collision]);
      expect(pluginTabLocation(collision, "/ui")).toEqual({
        pathname: "/ui/plugin",
        search: "?plugin=reports-fixture&id=summary",
        hash: "",
      });
      setPluginTabSlugs([collision]);
      expect(pluginSlugCandidate(`/ui/${slug}`, "/ui")).toBeNull();
      expect(pluginTabSlugFromPath(`/ui/${slug}`, "/ui")).toBeNull();
      expect(routeIdFromPath(`/ui/${slug}`, "/ui")).not.toBe("plugin");
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it("replaces generic URLs once, retaining page params and fragment", () => {
    setPluginTabSlugs([tab]);
    const generic = {
      pathname: "/ui/plugin",
      search: "?plugin=reports-fixture&id=summary&p.range=week&p.tag=a&p.tag=b",
      hash: "#latest",
    };
    const canonical = canonicalPluginTabLocation(generic, "/ui");
    expect(canonical).toEqual({
      pathname: "/ui/reports",
      search: "?p.range=week&p.tag=a&p.tag=b",
      hash: "#latest",
    });
    expect(canonicalPluginTabLocation(canonical, "/ui")).toBe(canonical);
    setPluginTabSlugs([]);
    expect(canonicalPluginTabLocation(generic, "/ui")).toBe(generic);
    expect(pluginTabRefFromSearch(generic.search)).toEqual({ pluginId: tab.pluginId, id: tab.id });
  });
});
