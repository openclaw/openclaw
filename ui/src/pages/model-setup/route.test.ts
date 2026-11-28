import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { page } from "./route.ts";

const location: RouteLocation = {
  pathname: "/settings/model-setup",
  search: "",
  hash: "",
};

describe("model setup route", () => {
  it.each([
    ["?firstRun=1", "?firstRun=1"],
    ["?firstRun=explicit", "?firstRun=explicit"],
    ["?firstRun=0&firstRun=explicit", "?connect=1"],
    ["", "?connect=1"],
  ])("redirects legacy link %s to Models %s", async (search, target) => {
    const context = { basePath: "/ui" } as ApplicationContext;
    const requested = { ...location, pathname: "/ui/settings/model-setup", search };
    const options: RouteLoaderOptions = createRouteLoaderOptions(requested, search);
    expect(await page.loader?.(context, options)).toEqual({
      type: "redirect",
      location: { pathname: "/ui/settings/model-providers", search: target, hash: "" },
    });
  });

  it("keys loader data by the first-run query", () => {
    const context = {} as ApplicationContext;

    expect(page.loaderDeps?.(context, location)).toBe("");
    expect(page.loaderDeps?.(context, { ...location, search: "?firstRun=1" })).toBe("?firstRun=1");
  });
});
