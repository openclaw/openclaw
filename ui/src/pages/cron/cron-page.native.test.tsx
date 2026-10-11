import { nothing, render } from "lit";
import { createComponent } from "solid-js";
import { expect, it } from "vitest";
import { renderSolidRoute } from "../../app/solid-route-legacy.tsx";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext, createGateway, createRequest } from "./cron-page.test-support.tsx";
import { CronPageBridge } from "./cron-page.tsx";

it("loads the empty automation suggestions when its Solid route host is attached", async () => {
  const context = createContext(createGateway(createTestGatewayClient(createRequest()), true));
  const host = document.body.appendChild(document.createElement("div"));
  try {
    render(
      renderSolidRoute({
        render: () => createComponent(CronPageBridge, {}),
        context,
        host,
        data: undefined,
        loaderPending: false,
        presented: true,
      }),
      host,
    );
    await waitForSolid(() => {
      expect(host.querySelectorAll(".cron-suggestion").length).toBeGreaterThan(0);
    });
  } finally {
    render(nothing, host);
    host.remove();
  }
});
