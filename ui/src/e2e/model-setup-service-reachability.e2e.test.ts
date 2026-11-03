import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  expectCount,
  installLocalSetupGateway,
  localPrepareOptions,
  makeDetection,
  setupContext,
  setupRpc,
} from "./model-setup-fixtures.test-support.ts";
import { openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Local service reachability setup",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("keeps the service's setup action and drops its duplicate install suggestion", async () => {
    await suite.withPage(
      setupContext({ colorScheme: "dark", viewport: { width: 1280, height: 900 } }),
      async ({ page }) => {
        const option = {
          id: "llama-app",
          brandId: "llama-app",
          label: "Llama app",
          hint: "Use models from the separate Llama app.",
          actionLabel: "Set up",
        };
        const siblings = localPrepareOptions().filter((entry) => entry.id !== "lmstudio");
        const detection = makeDetection({
          prepareOptions: [option, ...siblings],
          authOptions: [],
          recommendedInstalls: [
            {
              ...option,
              hint: "Get Llama app",
              website: "https://llama.app/",
              icon: "https://llama.app/favicon.ico",
            },
          ],
        });
        const gateway = await installLocalSetupGateway(page, detection, option.id, []);
        await openModelSetup(page, suite.server.baseUrl);
        const row = page.locator('[data-prepare-choice="llama-app"]');
        const button = row.getByRole("button", { name: "Set up", exact: true });
        await button.waitFor();
        await expectCount(page.locator('[data-recommended-install="llama-app"]'), 1);
        const capture = async (name: string) => {
          const frame = await takeControlUiScreenshotFrame(page, row, [button], {
            animations: "disabled",
            elements: [row],
            scrollTo: row,
          });
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        };
        await capture("initial-setup");
        const rows = page.locator("[data-prepare-choice]");
        await writeFile(
          path.join(suite.artifactDir, "provider-brand-facts.json"),
          JSON.stringify(
            await rows.evaluateAll((elements) =>
              elements.map((element) => ({
                provider: element.getAttribute("data-prepare-choice"),
                icon:
                  element
                    .querySelector("[data-provider-icon]")
                    ?.getAttribute("data-provider-icon") ?? null,
                fallback:
                  element.querySelector(".provider-brand-icon--fallback")?.textContent ?? null,
              })),
            ),
            null,
            2,
          ),
        );
        for (const [provider, brand, action] of [
          ["llama-app", "llama", "Set up"],
          ["llama-cpp", "llamacpp", "Set up model"],
          ["ollama", "ollama", "Choose connection"],
        ]) {
          const setupRow = page.locator(`[data-prepare-choice="${provider}"]`);
          await setupRow.getByRole("button", { name: action, exact: true }).waitFor();
          const logo = setupRow.locator(`[data-provider-icon="${brand}"]`);
          expect(
            await logo.count(),
            `${provider} must render its bundled brand, not a letter`,
          ).toBe(1);
          await expectCount(setupRow.locator(".provider-brand-icon--fallback, img, svg"), 0);
          const asset = await logo.evaluate(async (element) => {
            const style = getComputedStyle(element);
            const image = new Image();
            image.src = style.getPropertyValue("--provider-icon-url").trim().slice(5, -2);
            await image.decode();
            return {
              path: new URL(image.src).pathname,
              width: image.naturalWidth,
              mask: style.maskImage,
            };
          });
          expect(asset.path).toBe(`/provider-icons/ProviderIcon-${brand}.svg`);
          expect(asset.width).toBeGreaterThan(0);
          expect(asset.mask).toContain(asset.path);
        }
        await gateway.setMethodResponse(setupRpc.detect, {
          ...detection,
          prepareOptions: [{ ...option, serviceReachable: true }, ...siblings],
        });
        await page.getByRole("button", { name: "Check again", exact: true }).click();
        await page
          .getByText("Service found. Set up a model to continue.", { exact: true })
          .waitFor();
        await expectCount(page.locator('[data-recommended-install="llama-app"]'), 0);
        await capture("service-found-setup");
        await button.click();
        expect((await gateway.waitForRequest(setupRpc.prepare)).params).toMatchObject({
          authChoice: "llama-app",
        });
        expect(await gateway.getRequests(setupRpc.activate)).toHaveLength(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      },
    );
  });
});
