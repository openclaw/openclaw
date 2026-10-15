import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createHarness,
  createEmptyModelProvidersRouteData,
} from "./model-providers-page.test-support.tsx";
import { ModelProvidersPage } from "./model-providers-page.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("applies provider navigation without replacing an edited search during revalidation", async () => {
  const { context } = createHarness("writer");
  const routeData = { ...createEmptyModelProvidersRouteData(context), provider: "openai" };
  const [inputs, setInputs] = createSignal({ routeData, loaderPending: false });
  const view = mountSolid(
    () =>
      createComponent(ModelProvidersPage, {
        get routeData() {
          return inputs().routeData;
        },
        get loaderPending() {
          return inputs().loaderPending;
        },
      }),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  onTestFinished(view.unmount);
  const search = () =>
    view.container.querySelector<HTMLInputElement>(".model-providers__search input")!;
  await waitForSolid(() => expect(search()?.value).toBe("openai"));

  search().value = "anthropic";
  search().dispatchEvent(new Event("input", { bubbles: true }));
  await waitForSolid(() => expect(search()?.value).toBe("anthropic"));
  setInputs({ routeData, loaderPending: false });
  await waitForSolid(() => expect(search()?.value).toBe("anthropic"));
  // Route revalidation can publish its pending state before new route data arrives.
  setInputs({ routeData, loaderPending: true });
  flush();
  setInputs({ routeData, loaderPending: false });
  await waitForSolid(() => expect(search()?.value).toBe("anthropic"));
  setInputs({ routeData: { ...routeData }, loaderPending: false });
  await waitForSolid(() => expect(search()?.value).toBe("anthropic"));

  setInputs({ routeData: { ...routeData, provider: "minimax-portal" }, loaderPending: false });
  await waitForSolid(() => expect(search()?.value).toBe("minimax"));
  setInputs({ routeData: { ...routeData, provider: "" }, loaderPending: false });
  await waitForSolid(() => expect(search()?.value).toBe(""));
});
