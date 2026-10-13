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
      evaluateControlUiContext(page, (context) => {
        const snapshot = context.gateway.snapshot;
        return snapshot.phase === "connected" ? snapshot.hello?.auth?.scopes : null;
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

  it.each(["profile", "authority"] as const)(
    "keeps a delayed native decline bound to its admitted %s",
    async (changedOwner) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          const originalProfile = "11111111-1111-4111-8111-111111111111";
          const replacementProfile = "22222222-2222-4222-8222-222222222222";
          const updateAvailable = {
            channel: "stable" as const,
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          };
          const gateway = await installMockGateway(page, {
            updateAvailable,
            presenceUsers: [{ id: originalProfile, name: "Alex", self: true }],
            methodResponses: {
              "update.status": { updateAvailable },
              "update.run": { ok: true, restart: null, result: { status: "ok" } },
            },
          });
          const waitForProfile = async (profileId: string) => {
            await expect
              .poll(() =>
                evaluateControlUiContext(page, (context) => context.gateway.snapshot.selfUser?.id),
              )
              .toBe(profileId);
          };
          const decline = () =>
            evaluateControlUiContext(page, (context) => {
              window.dispatchEvent(new CustomEvent("openclaw:native-update-declined"));
              // Admission publishes synchronously before draining configuration writes.
              return context.overlays.snapshot.updateRunning;
            });
          const postNativeUpdate = async () => {
            const card = page.locator(
              'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
            );
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
          expect((await page.goto(suite.server.baseUrl + "chat"))?.status()).toBe(200);
          await gateway.waitForRequest("chat.startup");
          await waitForProfile(originalProfile);
          await installNativeBridge(page);
          await page.locator(".sidebar-issues-button:visible").click();
          await postNativeUpdate();
          expect(await page.locator("html").getAttribute("data-native-update-posts")).toBe("1");
          expect(await gateway.getRequests("update.run")).toHaveLength(0);

          if (changedOwner === "profile") {
            await gateway.setMethodResponse("users.self", {
              profile: {
                id: replacementProfile,
                displayName: "Sam",
                emails: [],
                avatarMime: null,
                hasAvatar: false,
                githubIdentity: null,
                mergedInto: null,
                createdAt: 1,
                updatedAt: 2,
              },
            });
            const connect = await gateway.waitForRequest("connect");
            const instanceId = (connect.params as { client: { instanceId: string } }).client
              .instanceId;
            await gateway.emitGatewayEvent("presence", {
              presence: [
                {
                  instanceId,
                  mode: "webchat",
                  reason: "connect",
                  user: { id: replacementProfile, name: "Sam" },
                  watchedSessions: [],
                },
              ],
            });
            await waitForProfile(replacementProfile);
          } else {
            await revokeAdmin(page, gateway);
          }
          expect(await decline()).toBe(false);
          expect(await gateway.getRequests("update.run")).toHaveLength(0);

          if (changedOwner === "authority") {
            const previousConnects = (await gateway.getRequests("connect")).length;
            await gateway.setOperatorScopes(["operator.admin"]);
            await gateway.closeLatest();
            await gateway.waitForRequest("connect", { after: previousConnects });
            await expect
              .poll(() =>
                evaluateControlUiContext(page, (context) => {
                  const snapshot = context.gateway.snapshot;
                  return snapshot.phase === "connected" ? snapshot.hello?.auth?.scopes : null;
                }),
              )
              .toEqual(["operator.admin"]);
          }
          // The declined intent is consumed even if authority later returns.
          expect(await decline()).toBe(false);
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          await postNativeUpdate();
          expect(await page.locator("html").getAttribute("data-native-update-posts")).toBe("2");
          expect(await decline()).toBe(true);
          await gateway.waitForRequest("update.run");
          await decline();
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
        },
      );
    },
  );
});
