import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { createRfbRawFrame, installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({ name: "Desktop panel observation abandonment" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("releases a late observation without opening RFB and reconnects on the same Gateway client", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const environmentId = "worker-desktop-abandonment";
      const discardedPath = `/desktop/observe?token=${"a".repeat(48)}`;
      const claimedPath = `/desktop/observe?token=${"b".repeat(48)}`;
      const environment = {
        id: environmentId,
        type: "worker",
        status: "available",
        desktop: true,
        worker: {
          providerId: "crabbox",
          state: "attached",
          ageMs: 1_000,
          attachedSessionIds: [],
          tunnelStatus: "connected",
          desktopApps: [],
        },
      };
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
          "desktop.observe": {
            transport: "rfb",
            wsPath: discardedPath,
            expiresAtMs: 60_000,
            control: false,
          },
          "desktop.release": { released: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}activity`);
      await waitForControlUiGatewayReady(page);
      const requester = await page.evaluateHandle(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime: { context: ApplicationContext };
        };
        return app.runtime.context.gateway.snapshot.client;
      });
      const sameRequester = () =>
        page.evaluate((original) => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          return (
            app.runtime.context.gateway.snapshot.client === original && original?.connected === true
          );
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
      const capture = async (name: string, content: readonly Locator[]) => {
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, name),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), content),
          );
        }
      };

      await open();
      await gateway.waitForRequest("desktop.observe");
      const pending = panel.getByRole("status", { name: "Connecting to desktop…" });
      await pending.waitFor();
      await capture("01-observation-pending.png", [pending]);
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
      await capture("02-late-observation-released.png", []);

      await gateway.setMethodResponse("desktop.observe", {
        transport: "rfb",
        wsPath: claimedPath,
        expiresAtMs: 60_000,
        control: false,
      });
      await open();
      await gateway.waitForRequest("desktop.observe", { after: 1 });
      const canvas = panel.locator(".desktop-surface canvas");
      await canvas.waitFor();
      await expect.poll(rfb.events).toEqual(["authenticated:1"]);
      await rfb.send([createRfbRawFrame()]);
      await expect
        .poll(() =>
          canvas.evaluate((element: HTMLCanvasElement) => {
            const pixel = element.getContext("2d")?.getImageData(0, 0, 1, 1).data;
            return pixel ? [...pixel] : null;
          }),
        )
        .toEqual([24, 180, 160, 255]);
      await expect.poll(() => pending.count()).toBe(0);
      expect(await sameRequester()).toBe(true);
      expect(await rfb.connectionCount()).toBe(1);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(2);
      await capture("03-reopened-desktop-frame.png", [canvas]);

      await panel.getByRole("button", { name: "Hide desktop panel", exact: true }).click();
      await expect.poll(rfb.events).toEqual(["authenticated:1", "closed:1"]);
      expect((await gateway.getRequests("desktop.release")).map(({ params }) => params)).toEqual([
        { wsPath: discardedPath },
      ]);
      await requester.dispose();
    });
  });
});
