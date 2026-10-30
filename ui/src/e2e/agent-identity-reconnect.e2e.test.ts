import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { cronJobsListResponse } from "../test-helpers/cron.ts";
import { expectText } from "./activity-assertions.test-support.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Agent identity save reconnect" });

suite.define(() => {
  it("keeps idle identity reads quiet and resumes after an announced restart", async () => {
    await suite.withPage({ locale: "en-US" }, async ({ page }) => {
      await page.clock.install();
      const gateway = await installMockGateway(page, {
        historyMessages: [],
        methodResponses: {
          "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          "cron.list": cronJobsListResponse([], { snapshotRevision: "idle" }),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat#token=test-token`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      const methods = ["agent.identity.get", "cron.list", "cron.status", "models.list"];
      // The sidebar defers startup reads until the foreground conversation is ready.
      await Promise.all(methods.map((method) => gateway.waitForRequest(method)));
      await pauseVirtualClock(page);
      const counts = async () =>
        Object.fromEntries(
          await Promise.all(
            methods.map(async (method) => [method, (await gateway.getRequests(method)).length]),
          ),
        );
      const connected = await counts();
      for (let minute = 0; minute < 10; minute++) {
        await page.clock.runFor(59_999);
        await gateway.emitGatewayEvent("presence", { presence: [] });
        await page.clock.runFor(1);
      }
      const idle = await counts();

      await gateway.setMethodResponse("agent.identity.get", {
        __mockError: {
          code: "UNAVAILABLE",
          message: "agent.identity.get unavailable during gateway restart",
          retryable: true,
          retryAfterMs: 1_000,
          details: { reason: "gateway-restarting" },
        },
      });
      await gateway.emitGatewayEvent("config.changed", { hash: "synthetic-restart" });
      await page.clock.runFor(1_000);
      const beforeDrain = await counts();
      await gateway.emitGatewayEvent("shutdown", { restartExpectedMs: 1_500 });
      await page.clock.runFor(600_000);
      const afterDrain = await counts();
      await gateway.setMethodResponse("agent.identity.get", {
        agentId: "main",
        name: "Cedar",
      });
      await page.clock.resume();
      await reconnectMockGateway(page, gateway);
      await expectText(page.locator(".agent-chat__welcome-identity h2")).toBe("Cedar");
      expect({ idle, afterDrain }).toEqual({ idle: connected, afterDrain: beforeDrain });
    });
  });

  it.each(["agents.update", "config.get"])(
    "keeps the identity draft editable after reconnect interrupts %s",
    async (heldMethod) => {
      await suite.withPage(
        { locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const config = { agents: { entries: { main: {} } } };
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "agents.update"],
            methodResponses: {
              "agents.update": { ok: true },
              "config.get": sourceConfigSnapshot(config, "identity-fixture"),
            },
          });
          await page.goto(`${suite.server.baseUrl}chat#token=test-token`);
          // Include an existing browser cache; reconnect must rediscover the target live.
          await expect
            .poll(() =>
              page.evaluate(() =>
                Object.keys(localStorage).some((key) =>
                  key.startsWith("openclaw.control.bootRecord.v1:"),
                ),
              ),
            )
            .toBe(true);
          await page.goto(`${suite.server.baseUrl}settings/agents/main/overview#token=test-token`);
          const name = page.locator(".agent-identity-editor__fields input").first();
          const before = (await gateway.getRequests(heldMethod)).length;
          await gateway.deferNext(heldMethod);
          await name.fill("Lunar museum guide");
          await gateway.waitForRequest(heldMethod, { after: before });
          const beforeRetry = (await gateway.getRequests("agents.update")).length;
          await reconnectMockGateway(page, gateway);
          await captureUiProof(suite, page, "identity", "reconnected.png");
          const retried = await gateway.waitForRequest("agents.update", { after: beforeRetry });
          expect(retried.params).toMatchObject({ agentId: "main", name: "Lunar museum guide" });
          await expect.poll(() => name.isEnabled()).toBe(true);
          const updates = (await gateway.getRequests("agents.update")).length;
          await name.fill("Lunar museum curator");
          const request = await gateway.waitForRequest("agents.update", { after: updates });
          expect(request.params).toMatchObject({ agentId: "main", name: "Lunar museum curator" });
          await expect.poll(() => name.isEnabled()).toBe(true);
        },
      );
    },
  );
});
