import type { Locator } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  calendarDiscoveryPlugin,
  calendarInspection,
  calendarPlugin,
  describeControlUiE2e,
  enabledWorkboardCapabilities,
  initialInventory,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

describeControlUiE2e("plugin install button progress", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("shows a catalog card as installed when its install succeeds", async () => {
    const evidence = createControlUiE2eArtifactDir("plugin-install-card-settle");
    const context = await newContext();
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: "dark" });
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": { items: [calendarDiscoveryPlugin] },
      },
    });
    const installed = { ...calendarPlugin, catalogId: calendarDiscoveryPlugin.id };
    try {
      await page.goto(`${server.baseUrl}plugins`);
      const cards = page.locator(
        `.plugin-catalog-card[data-plugin-id="${calendarDiscoveryPlugin.id}"]`,
      );
      const install = cards.first().getByRole("button", { name: "Install Calendar Plus" });
      await install.waitFor();
      await gateway.deferNext("plugins.install");
      await install.click();
      await gateway.waitForRequest("plugins.install");
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, installed], 1),
      );
      // Catalog pages come from ClawHub and can settle seconds after the local install.
      // Hold every follow-up read so only the final install result can settle the card.
      await gateway.deferNext("plugins.catalog.browse");
      await gateway.deferNext("config.get");
      const lists = (await gateway.getRequests("plugins.list")).length;
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: installed,
        restartRequired: false,
      });
      await gateway.waitForRequest("plugins.catalog.browse", { after: 1 });
      await expect
        .poll(() => cards.locator(".plugin-catalog-card__status").count())
        .toBe(await cards.count());
      expect(await cards.locator(".plugin-install-action__button").count()).toBe(0);
      expect(await gateway.getRequests("plugins.list")).toHaveLength(lists);
      if (captureUiProof) {
        await page.screenshot({ path: `${evidence}/after-install.png` });
      }
      await gateway.resolveDeferred("config.get");
      await gateway.waitForRequest("plugins.list", { after: lists });
      await gateway.resolveDeferred("plugins.catalog.browse", {
        items: [
          {
            ...calendarDiscoveryPlugin,
            local: {
              present: true,
              installed: true,
              enabled: true,
              state: "enabled",
              pluginId: installed.id,
              action: "manage",
            },
          },
        ],
      });
      expect(await cards.locator(".plugin-catalog-card__status").count()).toBe(await cards.count());
    } finally {
      await context.close();
    }
  });

  it.each([
    ["success", "", "", 0],
    ["failure", "Download failed", "Dependency installation failed", 4],
    ["runtime-failure", "Startup failed", "Plugin could not be applied to Gateway", 5],
    ["finalization-failure", "Refresh failed", "Installation failed", 6],
  ] as const)(
    "keeps truthful progress through the final %s response",
    async (outcome, message, label, completed) => {
      const evidence = createControlUiE2eArtifactDir(`plugin-install-progress-${outcome}`);
      const context = await newContext(undefined, {
        hasTouch: true,
        ...(captureUiProof ? { recordVideo: { dir: evidence } } : {}),
      });
      const page = await context.newPage();
      await page.clock.install();
      await page.emulateMedia({ colorScheme: "dark" });
      const methods = [...pluginMethods, "openclaw.chat", "openclaw.chat.history"];
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: pluginMethodResponses(),
      });
      const installed = { ...calendarPlugin, catalogId: calendarDiscoveryPlugin.id };
      const publishInstalled = async () => {
        await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
        await gateway.setMethodResponse("plugins.inspect", {
          ...calendarInspection,
          plugin: installed,
        });
      };
      try {
        await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
        const button = page.locator(".plugin-catalog-detail__install");
        const card = page.locator(".plugin-install-progress");
        const timer = card.locator(".plugin-install-progress__header > span");
        const countActivities = (state = "") =>
          card.locator(`.plugin-install-progress__activity${state && `--${state}`}`).count();
        const pluginButton = (action: string) =>
          page.getByRole("button", { name: `${action} Calendar Plus`, exact: true });
        const disable = pluginButton("Disable");
        const applying = card.getByText("Applying plugin to Gateway", { exact: true });
        const expectFocused = async (control: Locator) =>
          expect(await control.evaluate((el) => el === document.activeElement)).toBe(true);
        const expectText = async (control: Locator, text: string) =>
          expect(await control.textContent()).toContain(text);
        const expectInstallRequests = async (count: number) =>
          expect(await gateway.getRequests("plugins.install")).toHaveLength(count);
        const expectTick = async () => {
          const before = await timer.textContent();
          await page.clock.runFor(1100);
          await expect.poll(() => timer.textContent()).not.toBe(before);
        };
        const capture = async (prefix: string, widths: number[], fit?: "horizontal" | "both") => {
          for (const width of widths) {
            await page.setViewportSize({ width, height: 900 });
            await button.hover();
            if (fit) {
              await expect
                .poll(async () => {
                  const box = await card.boundingBox();
                  if (!box) {
                    return false;
                  }
                  const fitsWidth = box.x >= 0 && box.x + box.width <= width;
                  const fitsHeight = box.y >= 0 && box.y + box.height <= 900;
                  return fitsWidth && (fit === "horizontal" || fitsHeight);
                })
                .toBe(true);
            }
            if (captureUiProof) {
              await page.screenshot({ path: `${evidence}/${prefix}-${width}.png` });
            }
          }
        };
        const resolveInstall = async () => {
          await gateway.resolveDeferred("plugins.install", {
            ok: true,
            plugin: installed,
            restartRequired: false,
          });
          await disable.waitFor();
          expect(await card.count()).toBe(0);
        };
        await button.waitFor();
        if (captureUiProof) {
          await page.screenshot({ path: `${evidence}/before.png` });
        }
        await gateway.deferNext("plugins.install");
        await button.click();
        const request = await gateway.waitForRequest("plugins.install");
        await expectText(button, "Installing");
        expect(await button.isEnabled()).toBe(true);
        const activity = (stage: string, status: string, requestId = request.id) =>
          gateway.emitGatewayEvent("plugins.install.progress", {
            requestId,
            activityId: stage,
            stage,
            status,
          });
        await activity("resolve", "completed", "another-install");
        expect(await countActivities()).toBe(0);
        for (const stage of ["resolve", "download", "extract", "files"]) {
          await activity(stage, "started");
          await activity(stage, "completed");
        }
        await activity("dependencies", "started");
        await button.blur();
        await button.hover();
        await card.waitFor({ state: "visible" });
        expect(await countActivities("completed")).toBe(4);
        await expectTick();
        await expectText(card, "Installing plugin dependencies");
        const buttonBounds = (await button.boundingBox())!;
        const cardBounds = (await card.boundingBox())!;
        const gapY =
          cardBounds.y > buttonBounds.y
            ? (buttonBounds.y + buttonBounds.height + cardBounds.y) / 2
            : (cardBounds.y + cardBounds.height + buttonBounds.y) / 2;
        await page.mouse.move(buttonBounds.x + buttonBounds.width / 2, gapY);
        expect(await card.isVisible()).toBe(true);
        await card.hover();
        expect(await card.isVisible()).toBe(true);
        await button.click();
        await page.mouse.move(1400, 800);
        expect(await card.isVisible()).toBe(true);
        const outsideControl = page.locator(".plugins-settings-breadcrumb__parent");
        await outsideControl.focus();
        await expectFocused(outsideControl);
        expect(await card.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await card.waitFor({ state: "hidden" });
        await expectFocused(button);
        expect(await button.getAttribute("aria-expanded")).toBe("false");
        expect(await page.locator(".plugin-catalog-detail").count()).toBe(1);
        await button.blur();
        await button.focus();
        await card.waitFor({ state: "visible" });
        await capture("progress", [1440, 768, 390], "horizontal");
        await page.keyboard.press("Escape");
        await button.tap();
        await card.waitFor({ state: "visible" });
        await expectInstallRequests(1);
        await activity("dependencies", outcome === "failure" ? "failed" : "completed");
        if (outcome !== "failure") {
          expect(await countActivities("started")).toBe(0);
          await activity("runtime", "started");
          await applying.waitFor();
          expect(await countActivities("completed")).toBe(5);
          await expectTick();
          expect(await countActivities("started")).toBe(1);
          await expectText(button, "Installing");
          if (outcome === "success") {
            const inspections = (await gateway.getRequests("plugins.inspect")).length;
            await publishInstalled();
            await gateway.setMethodResponse("plugins.uiDescriptors", {
              ...enabledWorkboardCapabilities(),
              methods,
              controlUiTabs: [],
            });
            await gateway.emitGatewayEvent("plugins.changed", { generation: 1 });
            await gateway.waitForRequest("plugins.inspect", { after: inspections });
            await expectText(button, "Installing");
            expect(await card.isVisible()).toBe(true);
            expect(await applying.count()).toBe(1);
            expect(await disable.count()).toBe(0);
            expect(await pluginButton("Uninstall").count()).toBe(0);
          }
          await capture("runtime", [1440, 390]);
          await activity("runtime", outcome === "runtime-failure" ? "failed" : "completed");
        }
        if (outcome !== "success") {
          await gateway.rejectDeferred("plugins.install", {
            code: "UNAVAILABLE",
            message,
            ...(outcome === "failure"
              ? { details: { pluginInstallRejected: true } }
              : { details: { persistence: { operation: "install", pluginId: installed.id } } }),
          });
          await page.getByText(label, { exact: true }).waitFor();
          expect(await countActivities("completed")).toBe(completed);
          if (captureUiProof) {
            await page.screenshot({ path: `${evidence}/failure-state.png` });
          }
          expect((await button.textContent())?.trim()).toBe(
            outcome === "failure" ? "Retry install" : "View status",
          );
          expect(await button.locator(".btn__spinner").count()).toBe(0);
          const stoppedAt = await timer.textContent();
          await page.clock.runFor(1100);
          expect(await timer.textContent()).toBe(stoppedAt);
          expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
          if (captureUiProof) {
            await page.screenshot({ path: `${evidence}/after.png` });
          }
          await capture("failure", [1440, 1366, 768, 390], "both");
          if (outcome === "failure") {
            await expectText(card, "Plugin not installed");
            expect(await card.textContent()).not.toContain(
              "Resolve the reported issue, then select Retry install.",
            );
            await expectText(
              page.locator('.plugins-row-message[role="alert"]'),
              "This attempt did not install the plugin.",
            );
            await card.getByText("Failure details", { exact: true }).click();
            await card.getByText(message, { exact: true }).waitFor();
            await capture("failure-expanded", [1440, 1366, 768, 390], "both");
            const failureSummary = card.locator(".plugin-install-progress__failure > summary");
            await failureSummary.focus();
            await expectFocused(failureSummary);
            await page.keyboard.press("Escape");
            await card.waitFor({ state: "hidden" });
            await expect.poll(() => button.getAttribute("aria-expanded")).toBe("false");
            await page.mouse.move(0, 0);
            await button.hover();
            await card.waitFor({ state: "visible" });
            await gateway.deferNext("plugins.install");
            await button.click();
            await gateway.waitForRequest("plugins.install", { after: 1 });
            await expectText(button, "Installing");
            expect(await countActivities()).toBe(0);
            await publishInstalled();
            await resolveInstall();
            await expectInstallRequests(2);
            if (captureUiProof) {
              await page.screenshot({ path: `${evidence}/retry-success.png` });
            }
          } else {
            await button.click();
            await expectInstallRequests(1);
          }
        } else {
          expect(await countActivities("started")).toBe(0);
          await expectText(button, "Installing");
          await expectTick();
          await publishInstalled();
          await gateway.deferNext("config.get");
          // Final success changes actions before the unrelated config refresh can finish.
          await resolveInstall();
          await expectText(page.locator(".plugin-catalog-detail__actions"), "Ask OpenClaw");
          expect(await page.locator(".plugin-install-action__button").count()).toBe(0);
          if (captureUiProof) {
            await page.screenshot({ path: `${evidence}/after.png` });
          }
          await gateway.resolveDeferred("config.get");
        }
      } finally {
        await context.close();
      }
    },
  );
});
