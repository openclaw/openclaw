import { createRouter, type RouteLoaderOptions, type RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";

const location: RouteLocation = {
  pathname: "/settings/model-setup",
  search: "",
  hash: "",
};

describe("model setup route", () => {
  it.each([
    ["?firstRun=1", true],
    ["?firstRun=explicit", true],
    ["?firstRun=0", false],
    ["?firstRun=0&firstRun=explicit", false],
    ["", false],
  ])("preserves onboarding but redirects settings link %s to Models", async (search, firstRun) => {
    const context = { basePath: "/ui" } as ApplicationContext;
    const target = { ...location, pathname: "/ui/settings/model-setup", search };
    const options: RouteLoaderOptions = {
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      location: target,
      deps: search,
      cause: "navigation",
    };
    expect(await page.loader?.(context, options)).toEqual(
      firstRun
        ? { firstRun: true }
        : {
            type: "redirect",
            location: { pathname: "/ui/settings/model-providers", search: "?connect=1", hash: "" },
          },
    );
  });
  it("keys loader data by the first-run query", () => {
    const context = {
      agentSelection: { state: { selectedId: "main" } },
    } as ApplicationContext;

    expect(page.loaderDeps?.(context, location)).toBe("");
    expect(page.loaderDeps?.(context, { ...location, search: "?firstRun=1" })).toBe("?firstRun=1");
  });

  it("settles navigation without waiting for provider detection", async () => {
    const detected = createDeferred<SystemAgentSetupDetectResult>();
    const request = vi.fn(() => detected.promise);
    const context = {
      gateway: {
        snapshot: {
          client: { request },
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["openclaw.setup.detect"] },
          },
        },
      },
      agentSelection: { state: { selectedId: "main" } },
    } as unknown as ApplicationContext;
    const router = createRouter({ routes: [{ ...page, component: () => null }] });
    const navigation = router.navigate(
      "model-setup",
      context,
      {},
      { ...location, search: "?firstRun=1" },
    );
    try {
      await vi.waitFor(() => expect(router.getState().matches[0]?.status).toBe("success"));
    } finally {
      detected.resolve({
        candidates: [],
        manualProviders: [],
        workspace: "",
        setupComplete: false,
      });
      await navigation;
      router.stop();
    }
  });
});
