import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  calendarDiscoveryPlugin,
  calendarInspection,
  calendarPlugin,
  describeControlUiE2e,
  enabledWorkboardCapabilities,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

describeControlUiE2e("plugin install button progress", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it.each(["success", "failure", "runtime-failure", "finalization-failure"] as const)(
    "keeps truthful progress through the final %s response",
    async (outcome) => {
      const evidence = createControlUiE2eArtifactDir(`plugin-install-progress-${outcome}`);
      const context = await newContext(undefined, {
        hasTouch: true,
        recordVideo: { dir: evidence },
      });
      const page = await context.newPage();
      await page.clock.install();
      await page.emulateMedia({ colorScheme: "dark" });
      const gateway = await installMockGateway(page, {
        featureMethods: [...pluginMethods, "openclaw.chat", "openclaw.chat.history"],
        methodResponses: pluginMethodResponses(),
      });
      try {
        await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
        const button = page.locator(".plugin-catalog-detail__install");
        await button.waitFor();
        await page.screenshot({ path: `${evidence}/before.png` });
        await gateway.deferNext("plugins.install");
        await button.click();
        const request = await gateway.waitForRequest("plugins.install");
        const installed = { ...calendarPlugin, catalogId: calendarDiscoveryPlugin.id };
        expect(await button.textContent()).toContain("Installing");
        expect(await button.isEnabled()).toBe(true);
        const activity = async (stage: string, status: string, requestId = request.id) => {
          await gateway.emitGatewayEvent("plugins.install.progress", {
            requestId,
            activityId: stage,
            stage,
            status,
          });
        };
        await activity("resolve", "completed", "another-install");
        expect(await page.locator(".plugin-install-progress__activity").count()).toBe(0);
        for (const stage of ["resolve", "download", "extract", "files"]) {
          await activity(stage, "started");
          await activity(stage, "completed");
        }
        await activity("dependencies", "started");
        await button.hover();
        const card = page.locator(".plugin-install-progress");
        await card.waitFor({ state: "visible" });
        expect(await card.locator(".plugin-install-progress__activity--completed").count()).toBe(4);
        const timer = card.locator(".plugin-install-progress__header > span");
        const initialTime = await timer.textContent();
        await page.clock.runFor(1100);
        await expect.poll(() => timer.textContent()).not.toBe(initialTime);
        expect(await card.textContent()).toContain("Installing plugin dependencies");
        await card.hover();
        expect(await card.isVisible()).toBe(true);
        await button.click();
        await page.mouse.move(1400, 800);
        expect(await card.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await card.waitFor({ state: "hidden" });
        expect(await page.locator(".plugin-catalog-detail").count()).toBe(1);
        await button.blur();
        await button.focus();
        await card.waitFor({ state: "visible" });
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await button.hover();
          await expect
            .poll(async () => {
              const box = await card.boundingBox();
              return Boolean(box && box.x >= 0 && box.x + box.width <= width);
            })
            .toBe(true);
          await page.screenshot({ path: `${evidence}/progress-${width}.png` });
        }
        await page.keyboard.press("Escape");
        await button.tap();
        await card.waitFor({ state: "visible" });
        expect((await gateway.getRequests("plugins.install")).length).toBe(1);
        await activity("dependencies", outcome === "failure" ? "failed" : "completed");
        if (outcome !== "failure") {
          expect(await card.locator(".plugin-install-progress__activity--started").count()).toBe(0);
          await activity("runtime", "started");
          await card.getByText("Applying plugin to Gateway", { exact: true }).waitFor();
          expect(await card.locator(".plugin-install-progress__activity--completed").count()).toBe(
            5,
          );
          const applyingAt = await timer.textContent();
          await page.clock.runFor(1100);
          await expect.poll(() => timer.textContent()).not.toBe(applyingAt);
          expect(await card.locator(".plugin-install-progress__activity--started").count()).toBe(1);
          expect(await button.textContent()).toContain("Installing");
          if (outcome === "success") {
            const inspections = (await gateway.getRequests("plugins.inspect")).length;
            await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
            await gateway.setMethodResponse("plugins.inspect", {
              ...calendarInspection,
              plugin: installed,
            });
            await gateway.setMethodResponse("plugins.uiDescriptors", {
              ...enabledWorkboardCapabilities(),
              methods: [...pluginMethods, "openclaw.chat", "openclaw.chat.history"],
              controlUiTabs: [],
            });
            await gateway.emitGatewayEvent("plugins.changed", { generation: 1 });
            await gateway.waitForRequest("plugins.inspect", { after: inspections });
            expect(await button.textContent()).toContain("Installing");
            expect(await card.isVisible()).toBe(true);
            expect(
              await card.getByText("Applying plugin to Gateway", { exact: true }).count(),
            ).toBe(1);
            expect(
              await page
                .getByRole("button", { name: "Disable Calendar Plus", exact: true })
                .count(),
            ).toBe(0);
            expect(
              await page
                .getByRole("button", { name: "Uninstall Calendar Plus", exact: true })
                .count(),
            ).toBe(0);
          }
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await button.hover();
            await page.screenshot({ path: `${evidence}/runtime-${width}.png` });
          }
          await activity("runtime", outcome === "runtime-failure" ? "failed" : "completed");
        }
        if (outcome !== "success") {
          await gateway.rejectDeferred("plugins.install", {
            code: "UNAVAILABLE",
            message:
              outcome === "failure"
                ? "Registry refused the dependency download."
                : outcome === "runtime-failure"
                  ? "Plugin service failed to start."
                  : "Installed catalog refresh failed.",
            ...(outcome === "failure"
              ? { details: { pluginInstallRejected: true } }
              : { details: { persistence: { operation: "install", pluginId: installed.id } } }),
          });
          await page
            .getByText(
              outcome === "failure"
                ? "Dependency installation failed"
                : outcome === "runtime-failure"
                  ? "Plugin could not be applied to Gateway"
                  : "Installation failed",
              { exact: true },
            )
            .waitFor();
          expect(await card.locator(".plugin-install-progress__activity--completed").count()).toBe(
            outcome === "failure" ? 4 : outcome === "runtime-failure" ? 5 : 6,
          );
          await page.screenshot({ path: `${evidence}/failure-state.png` });
          expect((await button.textContent())?.trim()).toBe(
            outcome === "failure" ? "Retry install" : "View status",
          );
          expect(await button.locator(".btn__spinner").count()).toBe(0);
          const stoppedAt = await timer.textContent();
          await page.clock.runFor(1100);
          expect(await timer.textContent()).toBe(stoppedAt);
          expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
          await page.screenshot({ path: `${evidence}/after.png` });
          const captureFailure = async (expanded: boolean) => {
            for (const width of [1440, 1366, 768, 390]) {
              await page.setViewportSize({ width, height: 900 });
              await button.hover();
              await expect
                .poll(async () => {
                  const box = await card.boundingBox();
                  return Boolean(
                    box &&
                    box.x >= 0 &&
                    box.y >= 0 &&
                    box.x + box.width <= width &&
                    box.y + box.height <= 900,
                  );
                })
                .toBe(true);
              await page.screenshot({
                path: `${evidence}/failure-${expanded ? "expanded-" : ""}${width}.png`,
              });
            }
          };
          await captureFailure(false);
          if (outcome === "failure") {
            expect(await card.textContent()).toContain("Plugin not installed");
            expect(await card.textContent()).toContain(
              "Resolve the reported issue, then select Retry install.",
            );
            expect(
              await page.locator('.plugins-row-message[role="alert"]').textContent(),
            ).toContain("This attempt did not install the plugin.");
            await card.getByText("Failure details", { exact: true }).click();
            await card
              .getByText("Registry refused the dependency download.", { exact: true })
              .waitFor();
            await captureFailure(true);
            await gateway.deferNext("plugins.install");
            await button.click();
            await gateway.waitForRequest("plugins.install", { after: 1 });
            expect(await button.textContent()).toContain("Installing");
            expect(await card.locator(".plugin-install-progress__activity").count()).toBe(0);
            await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
            await gateway.setMethodResponse("plugins.inspect", {
              ...calendarInspection,
              plugin: installed,
            });
            await gateway.resolveDeferred("plugins.install", {
              ok: true,
              plugin: installed,
              restartRequired: false,
            });
            await page
              .getByRole("button", { name: "Disable Calendar Plus", exact: true })
              .waitFor();
            expect(await page.locator(".plugin-install-progress").count()).toBe(0);
            expect((await gateway.getRequests("plugins.install")).length).toBe(2);
            await page.screenshot({ path: `${evidence}/retry-success.png` });
          } else {
            await button.click();
            expect((await gateway.getRequests("plugins.install")).length).toBe(1);
          }
        } else {
          expect(await card.locator(".plugin-install-progress__activity--started").count()).toBe(0);
          expect(await button.textContent()).toContain("Installing");
          const waitingAt = await timer.textContent();
          await page.clock.runFor(1100);
          await expect.poll(() => timer.textContent()).not.toBe(waitingAt);
          await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
          await gateway.setMethodResponse("plugins.inspect", {
            ...calendarInspection,
            plugin: installed,
          });
          await gateway.deferNext("config.get");
          await gateway.resolveDeferred("plugins.install", {
            ok: true,
            plugin: installed,
            restartRequired: false,
          });
          // Final success changes actions before the unrelated config refresh can finish.
          await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
          expect(await page.locator(".plugin-install-progress").count()).toBe(0);
          expect(await page.locator(".plugin-catalog-detail__actions").textContent()).toContain(
            "Ask OpenClaw",
          );
          expect(await page.locator(".plugin-install-action__button").count()).toBe(0);
          await page.screenshot({ path: `${evidence}/after.png` });
          await gateway.resolveDeferred("config.get");
        }
      } finally {
        await context.close();
      }
    },
  );
});
