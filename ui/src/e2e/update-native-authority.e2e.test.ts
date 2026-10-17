import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Inbox native update authority E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const updateAvailable = {
  channel: "stable" as const,
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
};
const originalProfile = "11111111-1111-4111-8111-111111111111";
const replacementProfile = "22222222-2222-4222-8222-222222222222";
const withPage = (
  run: (page: Page, gateway: MockGatewayControls) => Promise<void>,
  scenario: Parameters<typeof installMockGateway>[1] = {},
) =>
  suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
    async ({ page }) => {
      const gateway = await installMockGateway(page, {
        updateAvailable,
        ...scenario,
        methodResponses: { "update.status": { updateAvailable }, ...scenario.methodResponses },
      });
      expect((await page.goto(suite.server.baseUrl + "chat"))?.status()).toBe(200);
      await gateway.waitForRequest("chat.startup");
      await run(page, gateway);
    },
  );
const nativePosts = (page: Page) => page.locator("html").getAttribute("data-native-update-posts");
const updateCard = (page: Page) =>
  page.locator('openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]');

async function installNativeBridge(page: Page) {
  await page.evaluate(() => {
    const postMessage = () => {
      const root = document.documentElement;
      root.dataset.nativeUpdatePosts = String(Number(root.dataset.nativeUpdatePosts ?? 0) + 1);
    };
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawUpdate: { postMessage } } },
    });
  });
}

async function setScopes(page: Page, gateway: MockGatewayControls, scopes: string[]) {
  const previousConnects = (await gateway.getRequests("connect")).length;
  await gateway.setOperatorScopes(scopes);
  await gateway.closeLatest();
  await gateway.waitForRequest("connect", { after: previousConnects });
  await expect
    .poll(() =>
      evaluateControlUiContext(page, (context) => {
        const snapshot = context.gateway.snapshot;
        return snapshot.phase === "connected" ? snapshot.hello?.auth?.scopes : null;
      }),
    )
    .toEqual(scopes);
}

suite.define(() => {
  it.each(["allowed", "before-restoration", "before-native-post", "initial-native"] as const)(
    "checks live Inbox native authority with revocation=%s",
    async (revokeAt) => {
      await withPage(async (page, gateway) => {
        if (revokeAt === "initial-native") {
          await installNativeBridge(page);
        }
        await page.locator(".sidebar-issues-button:visible").click();
        const card = updateCard(page);
        await card.locator("summary").click();
        await card.locator(".sidebar-update-card__action").click();
        const copy = page.locator("openclaw-modal-dialog");
        const confirm = (name: string) => copy.getByRole("button", { name, exact: true });
        const nativeConfirm = confirm("Update Mac app and restart");
        const gatewayConfirm = confirm("Update and restart");
        // Wait for the initial async freshness check and confirmation before changing its owner.
        await (revokeAt === "initial-native" ? nativeConfirm : gatewayConfirm).waitFor();
        if (revokeAt === "before-restoration") {
          await setScopes(page, gateway, ["operator.read"]);
        }
        if (revokeAt !== "initial-native") {
          await installNativeBridge(page);
          await gatewayConfirm.click();
        }
        if (revokeAt === "before-native-post" || revokeAt === "initial-native") {
          await setScopes(page, gateway, ["operator.read"]);
        }
        if (revokeAt !== "before-restoration") {
          await nativeConfirm.click();
        }
        if (revokeAt === "allowed") {
          await expect.poll(() => nativePosts(page)).toBe("1");
          await expect.poll(() => copy.count()).toBe(0);
        } else {
          expect(await nativePosts(page)).toBeNull();
          if (revokeAt === "before-restoration") {
            expect(await nativeConfirm.count()).toBe(0);
          }
          await expect
            .poll(async () => (await copy.getByRole("alert").allTextContents()).join(" "))
            .toContain("Administrator access is required");
        }
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      });
    },
  );

  it.each(["profile", "authority"] as const)(
    "keeps a delayed native decline bound to its admitted %s",
    async (changedOwner) => {
      await withPage(
        async (page, gateway) => {
          const waitForProfile = (profileId: string) =>
            expect
              .poll(() =>
                evaluateControlUiContext(page, (context) => context.gateway.snapshot.selfUser?.id),
              )
              .toBe(profileId);
          const decline = () =>
            evaluateControlUiContext(page, (context) => {
              window.dispatchEvent(new CustomEvent("openclaw:native-update-declined"));
              // Admission publishes synchronously before draining configuration writes.
              return context.overlays.snapshot.updateRunning;
            });
          const postNativeUpdate = async () => {
            const card = updateCard(page);
            if (!(await card.isVisible())) {
              await page.locator(".sidebar-issues-button:visible").click();
            }
            const action = card.locator(".sidebar-update-card__action");
            if (!(await action.isVisible())) {
              await card.locator("summary").click();
            }
            await action.click();
            await page
              .locator("openclaw-modal-dialog")
              .getByRole("button", { name: "Update Mac app and restart", exact: true })
              .click();
            await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
          };
          await waitForProfile(originalProfile);
          await installNativeBridge(page);
          await page.locator(".sidebar-issues-button:visible").click();
          await page.locator("#sidebar-issues-panel").waitFor();
          await postNativeUpdate();
          expect(await nativePosts(page)).toBe("1");
          expect(await gateway.getRequests("update.run")).toHaveLength(0);

          if (changedOwner === "profile") {
            await gateway.setMethodResponse("users.self", {
              profile: {
                id: replacementProfile,
                displayName: "Sam",
                emails: [],
                updatedAt: 2,
              },
            });
            const connect = await gateway.waitForRequest("connect");
            const instanceId = (connect.params as { client: { instanceId: string } }).client
              .instanceId;
            await gateway.emitGatewayEvent("presence", {
              presence: [{ instanceId, user: { id: replacementProfile, name: "Sam" } }],
            });
            await waitForProfile(replacementProfile);
          } else {
            await setScopes(page, gateway, ["operator.read"]);
          }
          expect(await decline()).toBe(false);
          expect(await gateway.getRequests("update.run")).toHaveLength(0);

          if (changedOwner === "authority") {
            await setScopes(page, gateway, ["operator.admin"]);
          }
          // The declined intent is consumed even if authority later returns.
          expect(await decline()).toBe(false);
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          await postNativeUpdate();
          expect(await nativePosts(page)).toBe("2");
          expect(await decline()).toBe(true);
          await gateway.waitForRequest("update.run");
          await decline();
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
        },
        {
          presenceUsers: [{ id: originalProfile, name: "Alex", self: true }],
          methodResponses: { "update.run": { ok: true, restart: null, result: { status: "ok" } } },
        },
      );
    },
  );
});
