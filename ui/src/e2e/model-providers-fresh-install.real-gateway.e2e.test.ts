import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

// A fresh install with default plugins and no provider credentials must present Models as
// ready to set up, not broken: real copy, no failure alerts, and provider display names.
let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Models on a fresh install",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "model-providers-fresh-install",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        // Host provider keys would make this an already configured install.
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
      },
      config: { gateway: { controlUi: { enabled: true } }, agents: { entries: { main: {} } } },
    });
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

async function open(route: string) {
  const handoff = await instance.cli(["dashboard", "--json"]);
  expect(handoff.code, handoff.stderr).toBe(0);
  const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
  const url = new URL(route, browserUrl);
  url.hash = new URL(browserUrl).hash;
  return url.href;
}

suite.define(() => {
  it("presents Models as ready to set up", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-model-readiness="model-required"]').waitFor();
        // Let catalog discovery settle so a late failure alert has time to appear.
        await page.waitForTimeout(8_000);
        const text = await page.locator("main, .settings-workspace, body").first().innerText();
        const alerts = await page.locator("[role='alert']:visible").allInnerTexts();
        expect(text).not.toContain("subtitles.modelProviders");
        expect(alerts.join(" ")).not.toMatch(/Couldn’t load models/u);

        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker
          .getByRole("button", { name: /^Tencent/ })
          .first()
          .click();
        const form = page.getByRole("dialog", { name: "Add provider" });
        const title = await form.locator(".oc-dialog__title").innerText();
        expect(title.trim()).not.toBe("tencent-tokenhub");
      },
    );
  });
});
