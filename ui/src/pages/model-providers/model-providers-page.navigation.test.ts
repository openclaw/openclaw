/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  appendPage,
  createEmptyModelProvidersRouteData,
  createHarness,
} from "./model-providers-page.test-support.ts";

afterEach(() => document.body.replaceChildren());

it("applies provider navigation without replacing an edited search during revalidation", async () => {
  const { context } = createHarness("writer");
  const page = appendPage(context);
  const routeData = { ...createEmptyModelProvidersRouteData(context), provider: "openai" };
  page.routeData = routeData;
  const search = () => page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  await waitForFast(() => expect(search()?.value).toBe("openai"));

  search().value = "anthropic";
  search().dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  // Route revalidation can publish its pending state before new route data arrives.
  Object.assign(page, { loaderPending: true });
  await page.updateComplete;
  Object.assign(page, { loaderPending: false });
  await waitForFast(() => expect(search()?.value).toBe("anthropic"));
  page.routeData = { ...routeData };
  await waitForFast(() => expect(search()?.value).toBe("anthropic"));

  page.routeData = { ...routeData, provider: "minimax-portal" };
  await waitForFast(() => expect(search()?.value).toBe("minimax"));
  page.routeData = { ...routeData, provider: "" };
  await waitForFast(() => expect(search()?.value).toBe(""));
});
