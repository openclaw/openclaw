import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Raw save parser loading E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("config.set adopts Raw saves while the JSON5 parser is unavailable", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      let parserRequests = 0;
      await page.route(/\/json5(?:\.js|\/dist\/index\.mjs)/, async (route) => {
        parserRequests += 1;
        await route.abort();
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": {
            config: { logging: { level: "info" } },
            raw: '{"logging":{"level":"info"}}',
            hash: "original",
            valid: true,
            issues: [],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/advanced`);
      await page.getByRole("button", { name: "Raw", exact: true }).click();
      const raw = page.locator(".config-raw-field textarea");
      const save = page.getByRole("button", { name: "Save", exact: true });
      for (const [index, level] of ["debug", "warn"].entries()) {
        const getsBeforeSave = (await gateway.getRequests("config.get")).length;
        await raw.fill(`{ logging: { level: "${level}" } }`);
        await save.click();
        const request = await gateway.waitForRequest("config.set", { after: index });
        expect(request.params).toMatchObject({
          baseHash: index === 0 ? "original" : "mock-config-hash-1",
        });
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(getsBeforeSave);
        await expect.poll(() => raw.isEnabled()).toBe(true);
      }
      await expect.poll(() => save.isEnabled()).toBe(false);
      expect(parserRequests).toBeGreaterThan(0);
      await page.reload();
      await page.getByRole("button", { name: "Raw", exact: true }).click();
      await expect.poll(() => raw.inputValue()).toContain('"warn"');
    });
  });
});
