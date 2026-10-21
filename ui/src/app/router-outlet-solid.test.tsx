/* @vitest-environment jsdom */
import { createRouter, definePage, type Router } from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { SolidRouteProps } from "../app-route-types.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { mountRouterOutlet, settleRouterOutlet } from "./router-outlet.test-support.tsx";

type RouteModule = { renderSolid: (props: SolidRouteProps) => JSX.Element };
type TestContext = { label: string };
type TestRouter = Router<"page" | "next", TestContext, RouteModule, string>;

it("preserves a routed page's focused draft through loader updates and retryable errors, then retires it on navigation", async () => {
  const firstCleanup = vi.fn();
  const secondCleanup = vi.fn();
  function FirstPage(props: SolidRouteProps) {
    const [draft, setDraft] = createSignal("");
    onCleanup(firstCleanup);
    return (
      <section>
        <input
          aria-label="Page draft"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <p>{`${String(props.data)} / ${props.loaderPending ? "loading" : "ready"}`}</p>
      </section>
    );
  }
  function SecondPage(props: SolidRouteProps) {
    onCleanup(secondCleanup);
    return <p>Replacement page: {String(props.data)}</p>;
  }
  const reload = createDeferredCore<string>();
  const failingReload = createDeferredCore<string>();
  const replies = ["Initial", reload.promise, failingReload.promise];
  const router: TestRouter = createRouter({
    routes: [
      definePage({
        id: "page",
        path: "/page",
        component: () => ({ renderSolid: FirstPage }),
        loader: (context) => replies.shift() ?? `Recovered ${context.label}`,
      }),
      definePage({
        id: "next",
        path: "/next",
        component: () => ({ renderSolid: SecondPage }),
        loader: () => "Next",
      }),
    ],
  });
  const context = { label: "test" };
  const outlet = mountRouterOutlet({ router, retryContext: context });
  try {
    await router.navigate("page", context);
    await settleRouterOutlet(outlet);
    const input = outlet.querySelector<HTMLInputElement>("input")!;
    input.focus();
    input.value = "Unsaved notes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    const expectDraft = (focused = true) => {
      expect(outlet.querySelector("input")).toBe(input);
      expect(input.value).toBe("Unsaved notes");
      if (focused) {
        expect(document.activeElement).toBe(input);
      }
      expect(firstCleanup).not.toHaveBeenCalled();
    };

    const revalidation = router.revalidate(context, "page");
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector("p")?.textContent).toBe("Initial / loading");
    expectDraft();

    reload.resolve("Loaded");
    await revalidation;
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector("p")?.textContent).toBe("Loaded / ready");
    expectDraft();

    const failure = router.revalidate(context, "page");
    await settleRouterOutlet(outlet);
    failingReload.reject(new Error("Fixture refresh failed"));
    await failure.catch(() => undefined);
    await settleRouterOutlet(outlet);
    expect(outlet.textContent).toContain("Fixture refresh failed");
    expect(outlet.querySelector(".lazy-view-error--inline")).not.toBeNull();
    expectDraft();

    const retry = outlet.querySelector<HTMLButtonElement>(".lazy-view-error__action")!;
    retry.focus();
    outlet.setInputs({ retryContext: { label: "retry" } });
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector(".lazy-view-error__action")).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(input.value).toBe("Unsaved notes");
    retry.click();
    await waitForSolid(() =>
      expect(outlet.querySelector("p")?.textContent).toBe("Recovered retry / ready"),
    );
    expectDraft(false);
    expect(outlet.querySelector(".lazy-view-error__action")).toBeNull();

    await router.navigate("next", context);
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector("input")).toBeNull();
    expect(outlet.querySelector("p")?.textContent).toBe("Replacement page: Next");
    expect(firstCleanup).toHaveBeenCalledOnce();
  } finally {
    outlet.dispose();
    router.stop();
    await Promise.resolve();
  }
  expect(secondCleanup).toHaveBeenCalledOnce();
});
