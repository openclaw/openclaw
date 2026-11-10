import { expect, it } from "vitest";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { createRfbRawFrame, installScriptedRfbServer } from "./desktop-rfb-test-support.ts";
import { canvasPixel, desktopObservation, workerDesktop } from "./panel-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Desktop panel observation abandonment" });

suite.define(() => {
  it("releases a late observation without opening RFB and reconnects on the same Gateway client", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const environmentId = "worker-desktop-abandonment";
      const discardedPath = `/desktop/observe?token=${"a".repeat(48)}`;
      const claimedPath = `/desktop/observe?token=${"b".repeat(48)}`;
      const environment = workerDesktop(environmentId);
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "desktop.observe",
          "desktop.release",
          "environments.list",
          "environments.status",
        ],
        deferredMethods: ["desktop.observe"],
        methodResponses: {
          "environments.list": { environments: [environment] },
          "environments.status": environment,
          "desktop.observe": desktopObservation(discardedPath),
          "desktop.release": { released: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}activity`);
      await waitForControlUiGatewayReady(page);
      const application = await getControlUiContextHandle(page);
      const requester = await application.evaluateHandle(
        (context) => context.gateway.snapshot.client,
      );
      const sameRequester = () =>
        application.evaluate((context, original) => {
          return context.gateway.snapshot.client === original && original?.connected === true;
        }, requester);
      // Only the RFB peer is scripted; the mounted viewer uses the real noVNC implementation.
      const rfb = await installScriptedRfbServer(page);
      const panel = page.locator("openclaw-desktop-panel");
      const open = () =>
        page.evaluate((target) => {
          window.dispatchEvent(
            new CustomEvent("openclaw:desktop-toggle", {
              detail: { open: true, environmentId: target },
            }),
          );
        }, environmentId);
      await open();
      await gateway.waitForRequest("desktop.observe");
      const pending = panel.getByRole("status", { name: "Connecting to desktop…" });
      await pending.waitFor();
      await panel.getByRole("button", { name: "Hide desktop panel", exact: true }).click();
      await panel.locator("section[aria-label='Desktop']").waitFor({ state: "hidden" });
      await gateway.resolveDeferred("desktop.observe");
      expect(await gateway.waitForRequest("desktop.release")).toMatchObject({
        params: { wsPath: discardedPath },
      });
      expect(await gateway.getRequests("desktop.release")).toHaveLength(1);
      expect(await sameRequester()).toBe(true);
      expect(await rfb.connectionCount()).toBe(0);
      expect(await rfb.events()).toEqual([]);

      await gateway.setMethodResponse("desktop.observe", desktopObservation(claimedPath));
      await open();
      await gateway.waitForRequest("desktop.observe", { after: 1 });
      const canvas = panel.locator(".desktop-surface canvas");
      await canvas.waitFor();
      await expect.poll(rfb.events).toEqual(["authenticated:1"]);
      await rfb.send([createRfbRawFrame()]);
      await expect.poll(() => canvasPixel(canvas)).toEqual([24, 180, 160, 255]);
      await expect.poll(() => pending.count()).toBe(0);
      expect(await sameRequester()).toBe(true);
      expect(await rfb.connectionCount()).toBe(1);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(2);

      await panel.getByRole("button", { name: "Hide desktop panel", exact: true }).click();
      await expect.poll(rfb.events).toEqual(["authenticated:1", "closed:1"]);
      expect((await gateway.getRequests("desktop.release")).map(({ params }) => params)).toEqual([
        { wsPath: discardedPath },
      ]);
      await requester.dispose();
      await application.dispose();
    });
  });
});
