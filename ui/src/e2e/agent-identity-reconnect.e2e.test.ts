import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
  reconnectMockGateway,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Agent identity save reconnect" });

suite.define(() => {
  it("keeps idle identity reads quiet and resumes after an announced restart", async () => {
    await suite.withPage({ locale: "en-US" }, async ({ page }) => {
      await page.clock.install();
      const gateway = await installMockGateway(page, {
        assistantName: "Atlas",
        historyMessages: [],
        methodResponses: {
          "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          "cron.list": {
            jobs: [],
            snapshotRevision: "idle",
            total: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            nextOffset: null,
          },
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

      await page.evaluate(() => {
        const fixture = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
        fixture.setRequestHandler("agent.identity.get", () => {
          const request = fixture.findRequests("agent.identity.get").at(-1)!;
          fixture.deliverLatest({
            type: "res",
            id: request.id,
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "agent.identity.get unavailable during gateway restart",
              retryable: true,
              retryAfterMs: 1_000,
              details: { reason: "gateway-restarting" },
            },
          });
        });
      });
      await gateway.emitGatewayEvent("config.changed", { hash: "synthetic-restart" });
      await page.clock.runFor(1_000);
      const beforeDrain = await counts();
      await gateway.emitGatewayEvent("shutdown", { restartExpectedMs: 1_500 });
      await page.clock.runFor(600_000);
      const afterDrain = await counts();
      const drainCalls = Object.fromEntries(
        methods.map((method) => [method, afterDrain[method] - beforeDrain[method]]),
      );
      console.log(
        JSON.stringify({ connected, idle, idleMinutes: 10, drainMinutes: 10, drainCalls }),
      );
      await page.evaluate(() => {
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.setRequestHandler(
          "agent.identity.get",
          ({ respond }) =>
            respond({ agentId: "main", name: "Cedar", avatar: "🌻", nameSource: "agent" }),
        );
      });
      await page.clock.resume();
      await reconnectMockGateway(page, gateway);
      await expect
        .poll(() => page.locator(".agent-chat__welcome-identity h2").textContent())
        .toBe("Cedar");
      expect(idle).toEqual(connected);
      expect(Object.values(drainCalls)).toEqual([0, 0, 0, 0]);
    });
  });

  it.each(["agents.update", "config.get"])(
    "keeps the identity draft editable after reconnect interrupts %s",
    async (heldMethod) => {
      await suite.withPage(
        { locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const artifacts = createControlUiE2eArtifactDir("agent-identity-reconnect");
          const config = { agents: { entries: { main: {} } } };
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "agents.update"],
            methodResponses: {
              "agents.update": { ok: true },
              "config.get": {
                config,
                sourceConfig: config,
                hash: "identity-fixture",
                issues: [],
                raw: JSON.stringify(config),
                valid: true,
              },
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
          const save = page
            .locator(".agent-identity-editor__actions")
            .getByRole("button", { name: /^(Save|Saving…)$/u });
          await name.fill("Lunar museum guide");
          const before = (await gateway.getRequests(heldMethod)).length;
          await gateway.deferNext(heldMethod);
          await save.click();
          await gateway.waitForRequest(heldMethod, { after: before });
          await expect.poll(() => save.textContent()).toContain("Saving");
          await reconnectMockGateway(page, gateway);
          await page.screenshot({
            path: path.join(artifacts, "reconnected.png"),
            animations: "disabled",
          });
          expect(await name.inputValue()).toBe("Lunar museum guide");
          await expect.poll(() => name.isEnabled()).toBe(true);
          await expect.poll(() => save.isEnabled()).toBe(true);
          await name.fill("Lunar museum curator");
          const updates = (await gateway.getRequests("agents.update")).length;
          await save.click();
          const request = await gateway.waitForRequest("agents.update", { after: updates });
          expect(request.params).toMatchObject({ agentId: "main", name: "Lunar museum curator" });
          await expect.poll(() => save.textContent()).toContain("Save");
          await expect.poll(() => name.isEnabled()).toBe(true);
        },
      );
    },
  );
});
