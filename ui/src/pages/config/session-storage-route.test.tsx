import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { createRouter, definePage, type Router } from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SessionStorageSettings } from "./session-storage.tsx";

function inventory(): SessionsStorageStatusResult {
  return {
    agents: [],
    maintenance: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null,
      archivedTranscripts: 0,
      externalizedTranscripts: 0,
    },
  };
}

it("leaves Storage while a submitted run is held and ignores its late completion", async () => {
  const heldRun = createDeferred<SessionsStorageStatusResult>();
  let runSignal: AbortSignal | undefined;
  const config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } } };
  const request = vi.fn(
    (method: string, _params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => {
      if (method === "sessions.storage.run") {
        runSignal = options?.signal;
        // A retired transport may still deliver its already admitted response.
        return heldRun.promise;
      }
      return Promise.resolve(
        method === "sessions.storage.status"
          ? inventory()
          : {
              config,
              hash: "raw-one",
              configRevisionHash: "revision-one",
              appliedConfigHash: "revision-one",
              valid: true,
              issues: [],
              raw: JSON.stringify(config),
            },
      );
    },
  );
  // SAFETY: This fixture implements the only client operation used by Storage.
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  await runtimeConfig.ensureLoaded();
  type RouteModule = { renderSolid: () => JSX.Element };
  const router: Router<"storage" | "next", object, RouteModule, undefined> = createRouter({
    routes: [
      definePage({
        id: "storage",
        path: "/storage",
        component: () => ({ renderSolid: StoragePage }),
        loader: () => undefined,
      }),
      definePage({
        id: "next",
        path: "/next",
        component: () => ({ renderSolid: () => <p>Next settings page</p> }),
        loader: () => undefined,
      }),
    ],
  });
  // SAFETY: Storage reads only these owners; the provider supplies shared fixture defaults.
  const context = { gateway, runtimeConfig, router } as unknown as ApplicationContext;
  const Provider = createSolidApplicationContextProvider(context).wrapper;
  function StoragePage() {
    return (
      <Provider>
        <SessionStorageSettings />
      </Provider>
    );
  }
  const outlet = mountRouterOutlet({ router, retryContext: context });
  try {
    await router.navigate("storage", context);
    const runButton = () =>
      [...outlet.querySelectorAll("button")].find((button) => button.textContent === "Run now");
    await waitForSolid(() => expect(runButton()?.disabled).toBe(false));
    runButton()!.click();
    flush();
    await waitForSolid(() => expect(runSignal).toBeDefined());

    await router.navigate("next", context);
    // Observe the destination itself: a global settle would wait for the deliberately held run.
    await waitForSolid(() => expect(outlet.textContent).toContain("Next settings page"));
    expect(outlet.querySelector("openclaw-session-storage-settings")).toBeNull();
    expect(runSignal?.aborted).toBe(true);
    const callsAtDeparture = request.mock.calls.length;

    heldRun.resolve(inventory());
    await heldRun.promise;
    flush();
    expect(request.mock.calls).toHaveLength(callsAtDeparture);
    expect(outlet.textContent).toContain("Next settings page");
    expect(outlet.textContent).not.toContain("Batch completed");

    await router.navigate("storage", context);
    await waitForSolid(() => expect(runButton()?.disabled).toBe(false));
    expect(outlet.textContent).not.toContain("Batch completed");
  } finally {
    heldRun.resolve(inventory());
    await heldRun.promise;
    flush();
    outlet.dispose();
    router.stop();
    runtimeConfig.dispose();
  }
});
