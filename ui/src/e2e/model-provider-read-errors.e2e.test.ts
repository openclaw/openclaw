import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Models provider read-error announcements" });
const authStatus = {
  ts: 1,
  providers: ["openai", "anthropic"].map((provider) => ({
    provider,
    status: "ok",
    profiles: [],
    apiKey: { source: "config" },
  })),
};
const usage = { updatedAt: 1, providers: [] };
const primaryError = "Provider access could not be refreshed. Try again.";
const usageError = "Provider usage is unavailable; the last request failed. Refresh to retry.";

suite.define(() => {
  it.each([
    { method: "models.authStatus", message: primaryError, response: authStatus },
    { method: "usage.status", message: usageError, response: usage },
  ])(
    "announces a failed $method read and recovers on refresh",
    async ({ method, message, response }) => {
      await suite.withPage(
        { locale: "en-US", colorScheme: "dark", viewport: { width: 1440, height: 1000 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            models: [
              {
                provider: "openai",
                id: "fixture-primary",
                name: "Fixture primary",
                available: true,
              },
              {
                provider: "anthropic",
                id: "fixture-secondary",
                name: "Fixture secondary",
                available: true,
              },
            ],
            methodResponses: {
              "config.get": { config: {}, hash: "model-provider-read-errors" },
              "models.authStatus": authStatus,
              "usage.status": usage,
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          await waitForControlUiRoute(page, {
            pathname: "/settings/model-providers",
            routeId: "model-providers",
          });
          const search = page.getByRole("searchbox", { name: "Search providers" });
          await search.fill("anthropic");
          await expect.poll(() => page.locator(".provider-row[data-provider-id]").count()).toBe(1);
          await search.fill("");
          await expect.poll(() => page.locator(".provider-row[data-provider-id]").count()).toBe(2);
          const list = page.locator(".model-providers__provider-list");
          expect(await list.getByRole("alert").count()).toBe(0);
          await gateway.setMethodResponse(method, {
            __mockError: { code: "UNAVAILABLE", message: primaryError },
          });
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          const notice = list.getByText(message, { exact: true });
          await notice.waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const stage = process.env.OPENCLAW_UI_PROOF_STAGE ?? "after";
            const frame = await takeControlUiScreenshotFrame(page, list, [notice], {
              animations: "disabled",
              elements: [list],
              scrollTo: notice,
            });
            await writeFile(path.join(suite.artifactDir, `${stage}-${method}.png`), frame.png);
            await writeFile(
              path.join(suite.artifactDir, `${stage}-${method}.ax.txt`),
              await list.ariaSnapshot(),
            );
          }
          expect(await list.getByRole("alert").filter({ hasText: message }).count()).toBe(1);
          const originalAlert = await list
            .getByRole("alert")
            .filter({ hasText: message })
            .elementHandle();
          expect(originalAlert).not.toBeNull();
          await search.fill("anthropic");
          await expect.poll(() => page.locator(".provider-row[data-provider-id]").count()).toBe(1);
          expect(await originalAlert?.evaluate((element) => element.isConnected)).toBe(true);
          await search.fill("");
          await expect.poll(() => page.locator(".provider-row[data-provider-id]").count()).toBe(2);
          expect(await originalAlert?.evaluate((element) => element.isConnected)).toBe(true);

          const waitingRead = await gateway.deferNext("models.authStatus");
          await gateway.setMethodResponse(method, response);
          try {
            await page
              .getByRole("button", {
                name: method === "models.authStatus" ? "Retry" : "Refresh",
                exact: true,
              })
              .click();
            await gateway.waitForRequest("models.authStatus", { after: waitingRead });
            await expect
              .poll(() => page.locator(".model-providers__refresh-button").isDisabled())
              .toBe(true);
            if (method === "models.authStatus") {
              expect(
                await page.getByRole("button", { name: "Retry", exact: true }).isDisabled(),
              ).toBe(true);
            }
            expect(await list.getByRole("alert").count()).toBe(1);
            expect(await originalAlert?.evaluate((element) => element.isConnected)).toBe(true);
          } finally {
            await gateway.resolveDeferred("models.authStatus", authStatus);
          }
          await expect.poll(() => notice.count()).toBe(0);
          expect(await list.getByRole("alert").count()).toBe(0);
          expect((await gateway.getRequests("models.authSetApiKey")).length).toBe(0);
          expect((await gateway.getRequests("models.authLogout")).length).toBe(0);
        },
      );
    },
  );
});
