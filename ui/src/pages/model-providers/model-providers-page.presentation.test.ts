/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import * as providerData from "./data.ts";
import {
  appendPage,
  createApiKeyProviderData,
  createHarness,
  publishRouteData,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("filters providers while typing without rebuilding the provider presentation", async () => {
  const { context } = createHarness("main");
  const page = appendPage(context);
  await waitForProviders(page);
  publishRouteData(page, createApiKeyProviderData());
  await page.updateComplete;
  const search = page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  const presentation = vi.spyOn(providerData, "buildModelProviderPresentation");

  for (const value of ["o", "op", "missing"]) {
    search.value = value;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
  }

  await waitForSolid(() => expect(page.querySelectorAll("[data-provider-id]")).toHaveLength(0));
  expect(presentation).not.toHaveBeenCalled();
});
