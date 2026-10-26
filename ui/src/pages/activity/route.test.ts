// @vitest-environment node
import type { RouteLocation } from "@openclaw/uirouter";
import { expect, it } from "vitest";
import { activityPersonFromPath, INTERNAL_ACTIVITY_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { page } from "./route.ts";
import { resolveActivityRouteData, type ActivityRouteData } from "./run-inspector-model.ts";

function loadRoute(search: string, pathname = "/activity", basePath = ""): ActivityRouteData {
  if (!page.loader) {
    throw new Error("activity route has no loader");
  }
  const loaded = page.loader(
    {} as ApplicationContext,
    createRouteLoaderOptions({ pathname, search, hash: "" } satisfies RouteLocation, search),
  );
  if (!("pathname" in loaded)) {
    throw new Error("activity route did not return a location");
  }
  return resolveActivityRouteData(loaded.search, activityPersonFromPath(loaded.pathname, basePath));
}

const sessions = (personId: string | null = null, query = "", time = "7d") => ({
  mode: "sessions",
  filters: { personId, query, time },
  selector: null,
});
const run = (
  selector: ActivityRouteData["selector"] = null,
  selectorId: string | null = null,
  decisionCursor: string | null = null,
) => ({ mode: "run", selector, selectorId, decisionCursor });

it.each([
  ["", sessions()],
  ["?view=other&run=ignored", sessions()],
  ["?person=alice&time=30d&q=release", sessions("alice", "release", "30d")],
  ["?view=run", run()],
  ["?view=run&run=%20%20", run()],
  [
    "?view=run&run=run-1&receipt=receipt%3Aa%2Fb&decision=cursor%3A10%3A2",
    run({ kind: "run", id: "run-1" }, "receipt:a/b", "cursor:10:2"),
  ],
  ["?view=run&run=run-1&decision=ignored-without-receipt", run({ kind: "run", id: "run-1" })],
] as const)("decodes activity filters and selection: %s", (search, expected) => {
  expect(loadRoute(search)).toEqual(expected);
});

it("scopes readable person paths independently of query filters and mounted prefixes", () => {
  for (const { pathname, search } of [
    { pathname: "/ui/activity/ada-12345678", search: "?person=ignored&time=30d&q=release" },
    {
      pathname: "/ui/activity",
      search: `?${INTERNAL_ACTIVITY_PATH_PARAM}=%2Fui%2Factivity%2Fada-12345678&person=ignored&time=30d&q=release`,
    },
  ]) {
    expect(loadRoute(search, pathname, "/ui")).toEqual(sessions("12345678", "release", "30d"));
  }
  expect(loadRoute("?view=live", "/activity/ada-12345678")).toEqual({
    mode: "live",
    selector: null,
  });
});

it("selects one exact execution without also sending the run selector", () => {
  const executionId = "execution:a/b % lobster";
  expect(loadRoute(`?view=run&run=ambiguous&execution=${encodeURIComponent(executionId)}`)).toEqual(
    run({ kind: "execution", id: executionId }),
  );
});
