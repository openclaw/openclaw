import { expect, it } from "vitest";
import { createApplicationRouter } from "../../app-routes.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext, createGateway, createRequest } from "./cron-page.test-support.tsx";

it("loads the empty automation suggestions when its Solid route host is attached", async () => {
  const context = createContext(createGateway(createTestGatewayClient(createRequest()), true));
  const router = createApplicationRouter();
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => <RouterOutlet router={router} retryContext={context} />, {
    wrapper: provider.wrapper,
  });
  try {
    await router.navigate("cron", context);
    await waitForSolid(() => {
      expect(mounted.container.querySelectorAll(".cron-suggestion").length).toBeGreaterThan(0);
    });
  } finally {
    mounted.unmount();
    router.stop();
  }
});
