import { createRouter, definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { action } from "solid-js";
import { expect, it } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { mountRouterOutlet, settleRouterOutlet } from "./router-outlet.test-support.tsx";

it("lets browser tasks complete while waiting for a route presentation commit", async () => {
  const context = { label: "page" };
  const router = createRouter({
    routes: [
      definePage({
        id: "page",
        path: "/page",
        component: () => ({ render: () => html`<p>Previous destination</p>` }),
      }),
      definePage({
        id: "next",
        path: "/next",
        component: () => ({ render: () => html`<p>Current destination</p>` }),
      }),
    ],
  });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  const completion = createDeferredCore();
  const channel = new MessageChannel();
  try {
    await router.navigate("page", context);
    await settleRouterOutlet(outlet);
    const navigation = action(function* () {
      const pending = router.navigate("next", context);
      yield completion.promise;
      yield pending;
    })();
    const settlement = outlet.settlePresentation();
    channel.port1.addEventListener("message", () => completion.resolve(), { once: true });
    channel.port1.start();
    channel.port2.postMessage(null);

    await navigation;
    await expect(settlement).resolves.toBe(true);
    expect(outlet.textContent).toContain("Current destination");
    expect(outlet.textContent).not.toContain("Previous destination");
  } finally {
    completion.resolve();
    channel.port1.close();
    channel.port2.close();
    outlet.dispose();
    router.stop();
  }
});
