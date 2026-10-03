import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Inbox native update authority E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

async function installNativeBridge(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          openclawUpdate: {
            postMessage: () => {
              const root = document.documentElement;
              root.dataset.nativeUpdatePosts = String(
                Number(root.dataset.nativeUpdatePosts ?? 0) + 1,
              );
            },
          },
        },
      },
    });
  });
}

async function revokeAdmin(page: Page, gateway: MockGatewayControls) {
  const previousConnects = (await gateway.getRequests("connect")).length;
  await gateway.setOperatorScopes(["operator.read"]);
  await gateway.closeLatest();
  await gateway.waitForRequest("connect", { after: previousConnects });
  await expect
    .poll(() =>
      page.evaluate(() => {
        // SAFETY: the production openclaw-app owns this runtime; only its public store is inspected.
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & { runtime?: { context: ApplicationContext } })
          | null;
        const snapshot = app?.runtime?.context.gateway.snapshot;
        return snapshot?.phase === "connected" ? snapshot.hello?.auth?.scopes : null;
      }),
    )
    .toEqual(["operator.read"]);
}

suite.define(() => {
  it.each(["allowed", "before-restoration", "before-native-post", "initial-native"] as const)(
    "checks live Inbox native authority with revocation=%s",
    async (revokeAt) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          const updateAvailable = {
            channel: "stable" as const,
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          };
          const gateway = await installMockGateway(page, {
            updateAvailable,
            methodResponses: { "update.status": { updateAvailable } },
          });
          expect((await page.goto(suite.server.baseUrl + "chat"))?.status()).toBe(200);
          await gateway.waitForRequest("chat.startup");
          if (revokeAt === "initial-native") {
            await installNativeBridge(page);
          }
          await page.locator(".sidebar-issues-button:visible").click();
          const card = page.locator(
            'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
          );
          await card.locator("summary").click();
          await card.locator(".sidebar-update-card__action").click();
          const copy = page.locator("openclaw-modal-dialog");
          const nativeConfirm = copy.getByRole("button", {
            name: "Update Mac app and restart",
            exact: true,
          });
          const gatewayConfirm = copy.getByRole("button", {
            name: "Update and restart",
            exact: true,
          });
          // Wait for the initial async freshness check and confirmation before changing its owner.
          await (revokeAt === "initial-native" ? nativeConfirm : gatewayConfirm).waitFor();
          if (revokeAt === "before-restoration") {
            await revokeAdmin(page, gateway);
          }
          if (revokeAt !== "initial-native") {
            await installNativeBridge(page);
            await gatewayConfirm.click();
          }
          if (revokeAt === "before-native-post" || revokeAt === "initial-native") {
            await revokeAdmin(page, gateway);
          }
          if (revokeAt !== "before-restoration") {
            await nativeConfirm.click();
          }
          if (revokeAt === "allowed") {
            await expect
              .poll(() => page.locator("html").getAttribute("data-native-update-posts"))
              .toBe("1");
            await expect.poll(() => copy.count()).toBe(0);
          } else {
            expect(await page.locator("html").getAttribute("data-native-update-posts")).toBeNull();
            if (revokeAt === "before-restoration") {
              expect(await nativeConfirm.count()).toBe(0);
            }
            await expect
              .poll(async () => (await copy.getByRole("alert").allTextContents()).join(" "))
              .toContain("Administrator access is required");
          }
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
        },
      );
    },
  );
});
