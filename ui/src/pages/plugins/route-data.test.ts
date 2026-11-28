// @vitest-environment node
import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import { canonicalPluginsRouteLocation, pluginsRouteLocation } from "./route-data.ts";

function location(url: string): RouteLocation {
  const { pathname, search, hash } = new URL(url, "https://control.test");
  return { pathname, search, hash };
}

describe("Plugins route data", () => {
  it.each([
    ["/plugins", null],
    ["/plugins/openclaw/linear", null],
    [
      "/plugins/ch_QG9wZW5jbGF3L2xpbmVhcg?probe=1#catalog",
      "/plugins/openclaw/linear?probe=1#catalog",
    ],
    ["/settings/plugins", null],
    ["/settings/plugins?tab=advanced", null],
    ["/settings/plugins/discover", "/plugins"],
    ["/plugins?tab=advanced", "/plugins"],
    ["/plugins?tab=discover", "/plugins"],
    ["/settings/plugins?tab=discover", "/plugins"],
    ["/settings/plugins?tab=installed", "/settings/plugins"],
    ["/settings/plugins?tab=unknown", "/settings/plugins"],
    ["/settings/plugins?tab=discover&query=calendar#featured", "/plugins?query=calendar#featured"],
  ] as const)("normalizes %s to %s", (sourceUrl, expectedUrl) => {
    const canonical = canonicalPluginsRouteLocation(location(sourceUrl));
    expect(canonical).toEqual(expectedUrl ? location(expectedUrl) : null);
  });

  it.each([
    [
      "dynamic pathname",
      "/settings/plugins?__openclawPluginsPath=%2Fsettings%2Fplugins%2Fdiscover&query=calendar#featured",
      "/settings/plugins/discover?query=calendar#featured",
    ],
    [
      "Plugin Settings detail",
      "/settings/plugins?__openclawPluginSettingsPath=%2Fsettings%2Fplugins%2Fcalendar&query=enabled#configuration",
      "/settings/plugins/calendar?query=enabled#configuration",
    ],
  ])("recovers %s without leaking the router parameter", (_, source, expected) => {
    expect(pluginsRouteLocation(location(source))).toEqual(location(expected));
  });
});
