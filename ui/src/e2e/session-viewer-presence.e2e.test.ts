import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI viewer presence acknowledgment",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("retries a lost viewer acknowledgment while healthy ticks keep the socket open", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.viewers.set"],
        deferredMethods: ["sessions.viewers.set"],
      });
      await page.clock.install();
      await page.goto(`${suite.server.baseUrl}chat`);
      const first = await gateway.waitForRequest("sessions.viewers.set");
      expect(first.params).toMatchObject({ sessionKeys: ["agent:main:main"] });
      await pauseVirtualClock(page);
      expect(await gateway.getSocketCount()).toBe(1);

      // The mock continues normal 30-second ticks while withholding only this
      // acknowledgment. Its operation deadline and existing retry delay both elapse.
      await page.clock.runFor(60_000);
      const declarations = await gateway.getRequests("sessions.viewers.set");
      expect(declarations).toHaveLength(2);
      expect(declarations[1]?.params).toEqual(first.params);
      expect(await gateway.getSocketCount()).toBe(1);
      expect(await gateway.getRequests("connect")).toHaveLength(1);

      await gateway.resolveDeferred("sessions.viewers.set", { sessionKeys: [] });
      await page.clock.runFor(60_000);
      expect(await gateway.getRequests("sessions.viewers.set")).toHaveLength(2);
      expect(await gateway.getSocketCount()).toBe(1);
    });
  });
});
