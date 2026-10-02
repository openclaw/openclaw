import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI pull request subscription acknowledgment",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("retries a lost subscription acknowledgment without reconnecting the healthy socket", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
        heldMethods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
      });
      await page.clock.install();
      await page.goto(`${suite.server.baseUrl}chat`);
      const scope = { sessionKeys: ["agent:main:main"] };
      const first = await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
        match: scope,
      });
      expect(first.params).toMatchObject(scope);
      await pauseVirtualClock(page);
      await page.clock.runFor(60_000);
      const declarations = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, scope);
      expect(declarations).toHaveLength(2);
      expect(declarations[1]?.params).toEqual(first.params);
      expect(await gateway.getSocketCount()).toBe(1);
      expect(await gateway.getRequests("connect")).toHaveLength(1);

      await gateway.deliverLatest({
        type: "res",
        id: declarations[1]?.id,
        ok: true,
        payload: { subscribed: true },
      });
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          "agent:main:main": {
            pullRequests: [
              {
                number: 123,
                owner: "openclaw",
                repo: "openclaw",
                title: "Synthetic subscription recovery",
                url: "https://github.com/openclaw/openclaw/pull/123",
                state: "open",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });
      await expect
        .poll(() => page.locator(".chat-pr").first().getAttribute("data-state"))
        .toBe("open");
      await page.clock.runFor(60_000);
      expect(await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, scope)).toHaveLength(
        2,
      );
      expect(await gateway.getSocketCount()).toBe(1);
    });
  });
});
