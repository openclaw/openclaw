import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity denial refresh" });
suite.define(() => {
  it("retains settled denial on unrelated events and recovers through Retry", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        colorScheme: "dark",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:demo",
          methodResponses: { "sessions.list": chatSessionListResponse([]) },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiRoute(page, { routeId: "activity", search: "" });
        await page.locator(".activity-feed__empty").waitFor();
        const match = { source: "activity", search: "denied" };
        const after = await gateway.deferNext("sessions.list", match);
        await page.locator(".activity-feed__search input").fill("denied");
        await gateway.waitForRequest("sessions.list", { after, match });
        await gateway.rejectDeferred(
          "sessions.list",
          { code: "FORBIDDEN", message: "This Activity query is not available to your account." },
          { match },
        );
        const alert = page.locator(".activity-feed__feedback [role=alert]");
        await alert.waitFor();
        await page.clock.install();
        await pauseVirtualClock(page);
        const initial = (await gateway.getRequests("sessions.list", match)).length;
        await gateway.deferNext("sessions.list", match);
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "update",
          sessionKey: "agent:main:unrelated",
        });
        await page.clock.runFor(6000);
        const facts = {
          initial,
          requests: (await gateway.getRequests("sessions.list", match)).length,
          skeleton: await page.locator(".activity-feed__loading").count(),
          alert: await alert.count(),
        };
        await page.clock.resume();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".activity-feed"),
            [page.locator(".activity-feed__search")],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, "refresh.png"), frame.png);
          writeFileSync(path.join(suite.artifactDir, "facts.json"), JSON.stringify(facts, null, 2));
          console.log("Activity evidence", suite.artifactDir, facts);
        }
        expect(facts).toEqual({ initial, requests: initial, skeleton: 0, alert: 1 });
        await page
          .locator(".activity-feed__feedback")
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await gateway.waitForRequest("sessions.list", { after: initial, match });
        await page.locator(".activity-feed__loading").waitFor();
        await gateway.resolveDeferred(
          "sessions.list",
          chatSessionListResponse([
            {
              key: "agent:main:demo",
              kind: "direct",
              label: "Recovered activity",
              updatedAt: Date.now(),
            },
          ]),
          { match },
        );
        const recovered = page
          .locator("[data-activity-session]")
          .getByText("Recovered activity", { exact: true });
        await recovered.waitFor();
        const acceptedNode = await recovered.elementHandle();
        const refreshAfter = await gateway.deferNext("sessions.list", match);
        await pauseVirtualClock(page);
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "update",
          sessionKey: "agent:main:demo",
        });
        await page.clock.runFor(6000);
        await gateway.waitForRequest("sessions.list", { after: refreshAfter, match });
        expect(await acceptedNode!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await page.locator(".activity-feed__loading").count()).toBe(0);
        await gateway.rejectDeferred(
          "sessions.list",
          { code: "FORBIDDEN", message: "Access was revoked." },
          { match },
        );
        await alert.waitFor();
        expect(await recovered.count()).toBe(0);
        await page.clock.resume();
      },
    );
  });
});
