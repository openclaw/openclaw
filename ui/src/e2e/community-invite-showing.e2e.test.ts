import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockSameOriginGatewayScript,
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI community invite showing E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const STORAGE_KEY = "openclaw:control-ui:community-invite:v2";

async function traceInviteMounts(page: Page) {
  await page.addInitScript(() => {
    const trace = { mounts: 0 };
    const seen = new WeakSet<Element>();
    (window as Window & { communityInviteTrace?: typeof trace }).communityInviteTrace = trace;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            for (const card of [node, ...node.querySelectorAll(".community-invite-card")]) {
              if (card.matches(".community-invite-card") && !seen.has(card)) {
                seen.add(card);
                trace.mounts += 1;
              }
            }
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () =>
        (window as Window & { communityInviteTrace?: { mounts: number } }).communityInviteTrace
          ?.mounts ?? 0,
    );
}

async function waitForInvitePolicy(page: Page, enabled: boolean) {
  await page.waitForFunction((expected) => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          runtime?: {
            context: {
              config: { current: { serverVersion: string | null; communityInvite: boolean } };
            };
          };
        })
      | null;
    const config = app?.runtime?.context.config.current;
    return config?.serverVersion != null && config.communityInvite === expected;
  }, enabled);
}

async function settleSidebarIdleWork(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(
          () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          { timeout: 3000 },
        );
      }),
  );
}

suite.define(() => {
  it("keeps the first policy-confirmed sidebar layout stable while invitation artwork loads", async () => {
    type LayoutWindow = Window & {
      sidebarInviteFirstLayout?: { invitationHeight: number; sidebarHeight: number };
    };

    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & {
              runtime?: { context: { config: { current: { communityInvite: boolean } } } };
            })
          | null;
        const sidebar = document.querySelector("openclaw-app-sidebar") as
          | (HTMLElement & { updateComplete: Promise<unknown> })
          | null;
        const row = sidebar?.querySelector(".sidebar-recent-session__link");
        if (
          !app?.runtime?.context.config.current.communityInvite ||
          !sidebar ||
          !row?.getBoundingClientRect().height
        ) {
          return;
        }
        observer.disconnect();
        // Capture the first policy-confirmed render, not a later settled card.
        void sidebar.updateComplete.then(() => {
          const invitation = sidebar.querySelector(".sidebar-shell__invite");
          const body = sidebar.querySelector(".sidebar-shell__body");
          if (!invitation || !body) {
            throw new Error("Expected the first sidebar layout");
          }
          (window as LayoutWindow).sidebarInviteFirstLayout = {
            invitationHeight: invitation.getBoundingClientRect().height,
            sidebarHeight: body.getBoundingClientRect().height,
          };
        });
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await installMockGateway(page, {
      communityInviteDismissed: false,
      methodResponses: {
        "sessions.list": sessionsListResponse(
          Array.from({ length: 13 }, (_, index) =>
            createControlUiSessionRow(
              `agent:main:early-${index}`,
              `Early session ${index}`,
              Date.now() - index * 60_000,
            ),
          ),
        ),
      },
      sessionKey: "agent:main:early-0",
    });
    let releaseArtwork!: () => void;
    let artworkRequested!: () => void;
    const artworkReady = new Promise<void>((resolve) => {
      releaseArtwork = resolve;
    });
    const artworkRequest = new Promise<void>((resolve) => {
      artworkRequested = resolve;
    });
    await page.route("**/community-art/community-invite-*.webp*", async (route) => {
      artworkRequested();
      await artworkReady;
      await route.continue();
    });
    try {
      await page.mouse.move(900, 500);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:early-0"));
      const firstLayout = await page.waitForFunction(
        () => (window as LayoutWindow).sidebarInviteFirstLayout,
      );
      const initial = await firstLayout.jsonValue();
      if (!initial) {
        throw new Error("Expected the first policy-confirmed sidebar layout");
      }
      expect(initial.invitationHeight).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Show more" }).click();
      const row = page.locator('.sidebar-recent-session[data-session-key="agent:main:early-10"]');
      await row.hover();
      const before = await row.boundingBox();
      expect(before).not.toBeNull();
      await artworkRequest;
      await settleSidebarIdleWork(page);
      releaseArtwork();
      await page.locator(".invite__art").evaluate((image: HTMLImageElement) => image.decode());
      await settleSidebarIdleWork(page);
      expect(await row.boundingBox()).toEqual(before);
      expect(await row.evaluate((element) => element.matches(":hover"))).toBe(true);
      expect(
        await page
          .locator(".sidebar-shell__body")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeCloseTo(initial.sidebarHeight, 2);
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Move to group" }).waitFor();
    } finally {
      releaseArtwork();
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["pointer", "keyboard", "drag", "touch"] as const)(
    "defers a late invitation during %s interaction without blocking navigation",
    async (interaction) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          hasTouch: interaction === "touch",
          viewport: { width: 1280, height: 900 },
        },
        async ({ context, page }) => {
          const dismissalWriter = interaction === "pointer" ? await context.newPage() : null;
          if (dismissalWriter) {
            await dismissalWriter.route("**/invitation-preference", (route) =>
              route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><title>Invitation preference writer</title>",
              }),
            );
            await dismissalWriter.goto(`${suite.server.baseUrl}invitation-preference`);
            await page.bringToFront();
          }
          const gateway = await installMockGateway(page, {
            communityInviteDismissed: false,
            methodResponses: {
              "sessions.list": sessionsListResponse(
                Array.from({ length: 13 }, (_, index) =>
                  createControlUiSessionRow(
                    `agent:main:session-${index}`,
                    `Session ${index}`,
                    Date.now() - index * 60_000,
                    {
                      ...(index === 0 ? { category: "Alpha" } : {}),
                      ...(index === 1 ? { category: "Beta" } : {}),
                    },
                  ),
                ),
              ),
            },
            sessionKey: "agent:main:session-0",
            sessionGroups: ["Alpha", "Beta"],
          });
          let communityInvite = true;
          let releasePolicy!: () => void;
          const policyReady = new Promise<void>((resolve) => {
            releasePolicy = resolve;
          });
          await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
            await policyReady;
            await route.fulfill({
              json: { ...createControlUiMockBootstrapConfig(), communityInvite },
            });
          });
          const refreshPolicy = async (enabled: boolean) => {
            communityInvite = enabled;
            const response = page.waitForResponse(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`);
            await gateway.closeLatest(1001, "policy refresh");
            await response;
            await waitForInvitePolicy(page, enabled);
          };
          try {
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-0"));
            await expect.poll(() => page.locator(".sidebar-recent-session").count()).toBe(12);
            const showMore = page.getByRole("button", { name: "Show more" });
            if (interaction === "touch") {
              await showMore.tap();
            } else {
              await showMore.click();
            }
            await expect.poll(() => page.locator(".sidebar-recent-session").count()).toBe(13);
            const sidebar = page.locator("openclaw-app-sidebar");
            const row = page.locator(
              '.sidebar-recent-session[data-session-key="agent:main:session-10"]',
            );
            const menu = row.locator(".sidebar-recent-session__link");
            const composer = page.locator(".agent-chat__composer-combobox textarea");
            const card = page.locator(".community-invite-card");
            await expect.poll(() => card.count()).toBe(0);
            if (interaction === "touch") {
              await row.locator("[data-sidebar-session-menu]").tap();
              await page.getByRole("menuitem", { name: "Move to group" }).waitFor();
            } else if (interaction === "keyboard") {
              await page.mouse.move(900, 500);
              await menu.focus();
            } else if (interaction === "drag") {
              await composer.focus();
              const bounds = await row.boundingBox();
              if (!bounds) {
                throw new Error("Expected a draggable session row");
              }
              // Start on the row's non-focusable top inset, then leave the sidebar.
              await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 1);
              await page.mouse.down();
              await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + 10, { steps: 5 });
              await expect
                .poll(() => row.getAttribute("class"))
                .toContain("sidebar-recent-session--dragging");
              // Native drag moves are dragover events; hover can remain on the source.
              await page.mouse.move(900, 450, { steps: 5 });
            } else {
              await row.hover();
            }
            const before = await row.boundingBox();
            releasePolicy();
            await waitForInvitePolicy(page, true);
            await settleSidebarIdleWork(page);
            expect(await row.boundingBox()).toEqual(before);
            expect(await card.count()).toBe(0);
            if (interaction === "drag") {
              expect(await row.getAttribute("class")).toContain("sidebar-recent-session--dragging");
              await page.keyboard.press("Escape");
              await page.mouse.up();
              await page.mouse.move(900, 450);
              await expect
                .poll(() => row.getAttribute("class"))
                .not.toContain("sidebar-recent-session--dragging");
              await composer.focus();
            } else {
              if (interaction === "keyboard") {
                await page.keyboard.press("Tab");
                expect(await sidebar.evaluate((element) => element.matches(":focus-within"))).toBe(
                  true,
                );
                expect(await card.count()).toBe(0);
                await page.keyboard.press("Shift+Tab");
                await menu.press("Shift+F10");
              } else if (interaction === "pointer") {
                await row.click({ button: "right" });
              }
              await page.getByRole("menuitem", { name: "Move to group" }).waitFor();
              await page.locator("openclaw-session-menu wa-dropdown-item:focus").waitFor();
              // A background render must not admit new geometry while a popover owns focus.
              await gateway.emitGatewayEvent("presence", { presence: [] });
              await settleSidebarIdleWork(page);
              expect(await card.count()).toBe(0);
              if (interaction === "touch") {
                await composer.tap();
              } else {
                await page.keyboard.press("Escape");
                await page.mouse.move(900, 500);
                expect(await card.count()).toBe(0);
                await composer.focus();
              }
            }
            await card.waitFor({ state: "visible" });
            const targetHeights = await card
              .locator(".invite__cta")
              .evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height));
            for (const height of targetHeights) {
              expect(height).toBeGreaterThanOrEqual(interaction === "touch" ? 44 : 40);
            }
            if (interaction === "touch") {
              await row.locator("[data-sidebar-session-menu]").tap();
            } else {
              await row.hover();
            }
            await card.locator("img").evaluate((image: HTMLImageElement) => image.decode());
            expect(await card.isVisible()).toBe(true);
            if (dismissalWriter) {
              await refreshPolicy(false);
              await card.waitFor({ state: "detached" });
              await refreshPolicy(true);
              await settleSidebarIdleWork(page);
              expect(await card.count()).toBe(0);
              // A real cross-tab storage event cancels the pending presentation.
              await dismissalWriter.evaluate((key) => {
                localStorage.setItem(key, JSON.stringify({ dismissedAtMs: Date.now() }));
              }, STORAGE_KEY);
              await settleSidebarIdleWork(page);
              await composer.click();
              await settleSidebarIdleWork(page);
              expect(await card.count()).toBe(0);
              await refreshPolicy(true);
              expect(await card.count()).toBe(0);
            }
          } finally {
            releasePolicy();
            if (interaction === "drag") {
              await page.mouse.up();
            }
          }
        },
      );
    },
  );

  it("honors deployment policy before showing and preserves browser dismissals", async () => {
    const viewport = { height: 900, width: 1280 };
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    const mountedInvites = await traceInviteMounts(page);
    await installMockGateway(page, { communityInviteDismissed: false });
    let communityInvite = false;
    let releaseBootstrap!: () => void;
    const bootstrapReady = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const imageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("community-art/")) {
        imageRequests.push(request.url());
      }
    });
    await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
      await bootstrapReady;
      await route.fulfill({
        json: { ...createControlUiMockBootstrapConfig(), communityInvite },
      });
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await page.locator(".sidebar-shell__footer").waitFor();
      const card = page.locator(".community-invite-card");
      await settleSidebarIdleWork(page);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(0);
      expect(imageRequests).toEqual([]);
      const bootstrapResponse = page.waitForResponse(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`);
      releaseBootstrap();
      await bootstrapResponse;
      await waitForInvitePolicy(page, false);
      await settleSidebarIdleWork(page);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(0);
      expect(imageRequests).toEqual([]);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
      communityInvite = true;
      await page.reload();
      await waitForInvitePolicy(page, true);
      await card.waitFor({ state: "visible" });
      await card.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      await expect
        .poll(() => card.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await card.waitFor({ state: "detached" });
      const dismissal = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
      expect(dismissal).not.toBeNull();

      for (const enabled of [false, true]) {
        communityInvite = enabled;
        await page.reload();
        await waitForInvitePolicy(page, enabled);
        await page.locator(".sidebar-shell__footer").waitFor();
        await settleSidebarIdleWork(page);
        expect(await card.count()).toBe(0);
        expect(await mountedInvites()).toBe(0);
        expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(
          dismissal,
        );
      }
    } finally {
      releaseBootstrap();
      await suite.closeBrowserContext(context);
    }
  });

  it("renews the old invitation once and preserves new dismissals across gateway connections", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, { communityInviteDismissed: false });
    await page.addInitScript(() => {
      localStorage.setItem(
        "openclaw:control-ui:community-invite",
        JSON.stringify({ dismissedAtMs: 1_760_000_001_000 }),
      );
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const card = page.locator(".community-invite-card");
      await card.waitFor({ state: "visible" });

      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

      const cta = page.getByRole("link", {
        name: "Join the OpenClaw community on Discord",
        exact: true,
      });
      expect(await cta.getAttribute("href")).toBe("https://discord.gg/clawd");
      expect(await cta.getAttribute("target")).toBe("_blank");
      expect((await cta.getAttribute("rel"))?.split(/\s+/u)).toEqual(
        expect.arrayContaining(["noopener", "noreferrer"]),
      );
      await context.route("https://discord.gg/**", (route) => route.abort());
      const popupPromise = context.waitForEvent("page");
      await cta.click();
      const popup = await popupPromise;
      await popup.close();
      await card.waitFor({ state: "visible" });
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await card.waitFor({ state: "detached" });
      expect(
        JSON.parse(
          (await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)) ?? "null",
        ),
      ).toMatchObject({
        dismissedAtMs: expect.any(Number),
      });

      await page.reload();
      await page.locator("openclaw-app-sidebar").waitFor();
      expect(await card.count()).toBe(0);

      const otherGatewayPage = await context.newPage();
      await installMockGateway(otherGatewayPage, { communityInviteDismissed: false });
      const otherGatewayUrl = new URL(`${suite.server.baseUrl}chat/main`);
      otherGatewayUrl.hash = new URLSearchParams({
        gatewayUrl: "ws://127.0.0.1:29991/another-gateway",
      }).toString();
      await otherGatewayPage.goto(otherGatewayUrl.href);
      const confirmation = otherGatewayPage.locator("openclaw-gateway-url-confirmation");
      await confirmation.waitFor({ state: "visible" });
      await confirmation
        .getByRole("button", { name: "Switch to 127.0.0.1:29991", exact: true })
        .click();
      await otherGatewayPage.locator("openclaw-app-sidebar").waitFor();
      expect(await otherGatewayPage.locator(".community-invite-card").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("does not mount the workspace invite in Settings", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, { communityInviteDismissed: false });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiSettingsTakeover(page);
      expect(await page.locator(".community-invite-card").count()).toBe(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("keeps a failed-save dismissal through remounts, server updates, and recovery reloads", async () => {
    const viewport = { height: 900, width: 1280 };
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    const mountedInvites = await traceInviteMounts(page);
    await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
    await page.addInitScript((key) => {
      // oxlint-disable-next-line typescript/unbound-method -- Each call below supplies its actual storage receiver.
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (storageKey, value) {
        if (this === localStorage && storageKey === key) {
          throw new DOMException("full", "QuotaExceededError");
        }
        setItem.call(this, storageKey, value);
      };
    }, STORAGE_KEY);
    const gateway = await installMockGateway(page, {
      communityInviteDismissed: false,
      // Broken boot must reach recovery without waiting for the roster.
      awaitInitialRoster: false,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const card = page.locator(".community-invite-card");
      await card.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Dismiss and don't show again" }).click();
      await card.waitFor({ state: "detached" });
      await page
        .getByText("Invitation dismissed, but your preference couldn't be saved.")
        .waitFor();
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

      expect(await mountedInvites()).toBe(1);

      await page.keyboard.press("Control+Shift+,");
      await waitForControlUiSettingsTakeover(page);
      await page.keyboard.press("Escape");
      await page.locator(".sidebar-shell__footer").waitFor();
      await settleSidebarIdleWork(page);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(1);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

      // Hold automatic recovery so the operator's stale-UI refresh action owns navigation.
      await page.evaluate(() => {
        sessionStorage.setItem("openclaw.controlUi.staleChunkReloadBuildId", "replacement-build");
      });
      await gateway.setOnline(false);
      await gateway.deferNext("connect");
      const previousConnections = (await gateway.getRequests("connect")).length;
      await gateway.setOnline(true);
      await gateway.waitForRequest("connect", { after: previousConnections });
      await gateway.rejectDeferred("connect", {
        code: "UNAVAILABLE",
        message: "protocol mismatch: Control UI updated; reload this page to continue",
        details: {
          code: "PROTOCOL_MISMATCH",
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
        retryable: false,
      });
      const updatedDocument = page.waitForEvent("domcontentloaded");
      await page.getByRole("button", { name: /Server updated/u }).click();
      await updatedDocument;
      await waitForInvitePolicy(page, true);
      await page.locator(".sidebar-shell__footer").waitFor();
      await settleSidebarIdleWork(page);
      expect(new URL(page.url()).origin).toBe(new URL(suite.server.baseUrl).origin);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

      let failModule = true;
      let failedModuleRequests = 0;
      await page.route(`${new URL(suite.server.baseUrl).origin}/**`, async (route) => {
        const request = route.request();
        if (request.resourceType() === "document" && failModule) {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            'data-openclaw-mount-timeout-ms="12000"',
            'data-openclaw-mount-timeout-ms="250"',
          );
          await route.fulfill({ response, body });
          return;
        }
        if (new URL(request.url()).pathname === "/src/main.ts" && failModule) {
          failedModuleRequests += 1;
          await route.fulfill({ body: "gateway restarting", status: 503 });
          return;
        }
        await route.fallback();
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      // Let automatic recovery exhaust its fresh-document attempt before the manual retry.
      await expect.poll(() => failedModuleRequests).toBe(2);
      await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
      failModule = false;
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await waitForInvitePolicy(page, true);
      await page.locator(".sidebar-shell__footer").waitFor();
      await settleSidebarIdleWork(page);
      expect(await card.count()).toBe(0);
      expect(await mountedInvites()).toBe(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("hides after a malformed cross-tab state update", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, { communityInviteDismissed: false });

    try {
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const card = page.locator(".community-invite-card");
      await card.waitFor({ state: "visible" });

      await page.evaluate((key) => {
        localStorage.setItem(key, "{");
        window.dispatchEvent(new StorageEvent("storage", { key, newValue: "{" }));
      }, STORAGE_KEY);

      await card.waitFor({ state: "detached" });
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("{");
    } finally {
      await context.close();
    }
  });
});
