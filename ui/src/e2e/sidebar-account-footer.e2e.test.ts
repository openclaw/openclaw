import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUnionProof,
  createSidebarFooterProofSuite,
  openSidebarFooterProofPage,
  setSidebarProofTheme,
} from "./sidebar-footer-proof.test-support.ts";

const featureBuild: ControlUiBuildInfo = {
  version: "2026.8.14",
  commit: "0123456789abcdef0123456789abcdef01234567",
  commitAt: "2026-08-14T12:00:00.000Z",
  builtAt: "2026-08-14T12:00:00.000Z",
  branch: "feat/sidebar-footer",
  dirty: false,
  release: false,
  buildId: "sidebar-account-footer-feat-sidebar-footer",
};

async function openIdentityMenu(page: Page, sidebar: Locator) {
  await setSidebarProofTheme(page, "dark");
  await waitForControlUiGatewayReady(page);
  await sidebar.locator(".sidebar-identity-card").click();
  await page.mouse.move(0, 0);
  const menu = sidebar.locator(".sidebar-identity-menu");
  await menu.waitFor();
  return menu;
}

async function expectRailConnectionStatus(footer: Locator, kind: string, label: string) {
  const identity = footer.locator(".sidebar-identity-card");
  await expect.poll(() => identity.getAttribute("data-connection-status")).toBe(kind);
  expect(await identity.isVisible()).toBe(true);
  expect(await identity.locator(".sidebar-identity-card__status").isVisible()).toBe(true);
  expect(await footer.locator(".gateway-status").count()).toBe(0);
  expect(await identity.getAttribute("aria-label")).toBe(
    `Identity and app menu for Riley: ${label}`,
  );
  expect(
    await identity.evaluate(
      (element) =>
        element.getAttribute("title") ||
        element.ownerDocument
          .getElementById(element.getAttribute("aria-describedby") ?? "")
          ?.textContent?.trim(),
    ),
  ).toBe(`Identity and app menu for Riley: ${label}`);
  expect(await footer.locator(":scope > [role=status]").count()).toBe(0);
  expect(await identity.getByRole("status").count()).toBe(0);
}

async function runAccountFooterProof(page: Page, sidebar: Locator) {
  const identity = sidebar.locator(".sidebar-identity-card");
  for (const part of [identity.locator("openclaw-viewer-avatar"), identity]) {
    await part.click();
    await expect.poll(() => sidebar.locator(".sidebar-identity-menu").count()).toBe(1);
    await page.keyboard.press("Escape");
    await expect.poll(() => sidebar.locator(".sidebar-identity-menu").count()).toBe(0);
  }

  for (const theme of ["light", "dark"] as const) {
    await setSidebarProofTheme(page, theme);
    await page.mouse.move(0, 0);

    await identity.focus();
    await page.keyboard.press("Enter");
    const menu = sidebar.locator(".sidebar-identity-menu");
    await menu.waitFor();
    expect(await menu.locator('[data-value="command:recent-activity"]').count()).toBe(0);
    expect(await menu.evaluate((dropdown) => dropdown.closest("openclaw-menu-surface"))).toBeNull();

    const buildLink = menu.getByRole("menuitem", { name: "Control UI build details" });
    expect((await buildLink.textContent())?.trim().startsWith("feat/sidebar-f…@0123456 · ")).toBe(
      true,
    );
    const buildTooltip = sidebar.locator(
      "openclaw-sidebar-build-chip openclaw-tooltip .tooltip-surface[popover]",
    );
    const buildTooltipCard = sidebar.locator(".sidebar-build-hover-card");
    await page.clock.install();
    await buildLink.hover();
    await page.clock.runFor(300);
    await page.mouse.move(0, 0);
    await page.clock.runFor(300);
    expect(await buildTooltip.evaluate((element) => element.matches(":popover-open"))).toBe(false);
    await buildLink.hover();
    await page.clock.runFor(600);
    await expect
      .poll(() => buildTooltip.evaluate((element) => element.matches(":popover-open")))
      .toBe(true);
    await page.clock.resume();
    await captureUnionProof(suite, page, "sidebar-account-footer", `${theme}-build-hover.png`, [
      buildTooltipCard,
    ]);
    await page.mouse.move(0, 0);
    await buildTooltipCard.waitFor({ state: "hidden" });

    const settings = menu.locator('[data-value="command:settings"]');
    const settingsShortcut = settings.locator(".session-menu__shortcut");
    expect(
      await settingsShortcut.evaluate((element) => getComputedStyle(element).fontFamily),
    ).toMatch(/^system-ui,/u);
    const settingsRestBackground = await settings.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await settings.hover();
    await expect.poll(() => settings.evaluate((element) => element.matches(":hover"))).toBe(true);
    await expect
      .poll(() => settings.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(settingsRestBackground);

    const usage = menu.locator('[data-value="command:usage"]');
    await usage.focus();

    const themeToggle = menu.locator(".theme-mode-toggle");
    const themeLabel = await themeToggle.getAttribute("aria-label");
    await themeToggle.click();
    await expect.poll(() => themeToggle.getAttribute("aria-label")).not.toBe(themeLabel);

    const help = menu.locator('[data-value="command:help"]');
    await help.hover();
    const submenu = help.locator("..").locator('[role="menu"]');
    await submenu.waitFor({ state: "visible" });

    await page.keyboard.press("Escape");
    await submenu.waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await expect.poll(() => menu.count()).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement instanceof HTMLElement ? document.activeElement.className : "",
        ),
      )
      .toContain("sidebar-identity-card");
  }
}

const gatewayBuild = {
  serverVersion: featureBuild.version ?? undefined,
  serverBuildId: featureBuild.buildId,
};
const suite = createSidebarFooterProofSuite(
  "Control UI sidebar account footer feature build E2E",
  featureBuild,
);

async function withFooter(
  run: (opened: Awaited<ReturnType<typeof openSidebarFooterProofPage>>) => Promise<void>,
  options: Parameters<typeof openSidebarFooterProofPage>[1] = gatewayBuild,
) {
  const opened = await openSidebarFooterProofPage(suite, options);
  try {
    await run(opened);
  } finally {
    await suite.closeBrowserContext(opened.context);
  }
}

suite.define(() => {
  it.each(["stable", "beta", "dev"] as const)(
    "gates release-update notifications on %s",
    async (channel) => {
      const updateAvailable = { channel, currentVersion: "1.0.0", latestVersion: "2.0.0" };
      const updateSchedule = {
        channel,
        autoEnabled: false,
        target: { kind: "package" as const, version: "2.0.0" },
      };
      await withFooter(
        async ({ gateway, page, sidebar }) => {
          const menu = await openIdentityMenu(page, sidebar);
          const updates = menu.getByRole("menuitem", { name: /^Updates/ });
          await updates.waitFor();
          const badge = updates.getByText("Available", { exact: true });
          await expect.poll(() => badge.count()).toBe(channel === "dev" ? 0 : 1);
          await expect
            .poll(() => sidebar.locator(".sidebar-issues-button__count").count())
            .toBe(channel === "dev" ? 0 : 1);
          if (channel === "stable") {
            // The selected schedule wins over leftover availability from another channel.
            await gateway.emitGatewayEvent("update.available", {
              updateAvailable,
              schedule: { ...updateSchedule, channel: "dev" },
            });
            await expect.poll(() => badge.count()).toBe(0);
            await expect
              .poll(() => sidebar.locator(".sidebar-issues-button__count").count())
              .toBe(0);
            await gateway.emitGatewayEvent("update.available", {
              updateAvailable: { ...updateAvailable, channel: "beta" },
              schedule: { ...updateSchedule, channel: "beta" },
            });
            await expect.poll(() => badge.count()).toBe(1);
            await gateway.emitGatewayEvent("update.available", {
              updateAvailable: { channel: "beta", currentVersion: "2.0.0", latestVersion: "2.0.0" },
              schedule: { channel: "beta", autoEnabled: false },
            });
            await expect.poll(() => badge.count()).toBe(0);
          }
          await updates.click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/updates");
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
        },
        {
          ...gatewayBuild,
          operatorScopes: ["operator.read", "operator.admin"],
          updateAvailable,
          updateSchedule,
        },
      );
    },
  );

  it("opens Updates settings from the account menu without starting an update", async () => {
    await withFooter(async ({ gateway, page, sidebar }) => {
      const menu = await openIdentityMenu(page, sidebar);
      await menu.getByRole("menuitem", { name: "Updates", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/updates");
      await expect.poll(() => menu.count()).toBe(0);
      await page.getByRole("heading", { name: "Updates", exact: true }).waitFor();
      await gateway.waitForRequest("update.status");
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
      await page.getByRole("button", { name: "Back to app", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
    });
  });

  it("labels the lifecycle status on the account icon during automatic recovery", async () => {
    await withFooter(
      async ({ gateway, page, sidebar }) => {
        const footer = sidebar.locator(".sidebar-footer-bar");
        const identity = footer.locator(".sidebar-identity-card");
        const connectionStatus = page.locator(".sidebar-shell__footer .gateway-status:visible");
        const announcement = page.locator(".shell > .sr-only[role=status]");
        await setSidebarProofTheme(page, "dark");
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await waitForControlUiGatewayReady(page);
        await expectRailConnectionStatus(footer, "suspended", "Suspended");
        await expect
          .poll(() => connectionStatus.locator(".gateway-status__label").textContent())
          .toBe("Suspended");
        const inbox = footer.locator("openclaw-sidebar-attention");
        expect(await inbox.getByRole("status").count()).toBe(1);
        expect(await inbox.getByRole("status").textContent()).toBe(
          await inbox.locator(".sidebar-issues-button").getAttribute("aria-label"),
        );
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
        await expect.poll(() => identity.getAttribute("data-connection-status")).toBe("connected");
        await connectionStatus.waitFor({ state: "detached" });
        expect(await announcement.textContent()).toBe("Connected");

        for (const [phase, label] of [
          ["preparing", "Suspending…"],
          ["draining", "Suspending…"],
          ["prepared", "Suspended"],
        ] as const) {
          await gateway.emitGatewayEvent("gateway.suspension", { phase });
          await expectRailConnectionStatus(
            footer,
            phase === "prepared" ? "suspended" : "suspending",
            label,
          );
          await expect
            .poll(() => connectionStatus.locator(".gateway-status__label").textContent())
            .toBe(label);
          expect(await announcement.textContent()).toBe(label);
        }
        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar.locator('[data-value="command:settings"]').click();
        const settingsFooter = page.locator(".settings-sidebar__footer");
        await settingsFooter.waitFor();
        expect(await settingsFooter.locator(".gateway-status").count()).toBe(1);
        expect(await settingsFooter.locator("openclaw-settings-save-indicator").count()).toBe(1);
        await expect
          .poll(() => connectionStatus.locator(".gateway-status__label").textContent())
          .toBe("Suspended");
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
        await connectionStatus.waitFor({ state: "detached" });
        expect(await settingsFooter.locator("openclaw-settings-save-indicator").count()).toBe(1);
        await page.locator(".settings-sidebar__back").click();
        await sidebar.waitFor();
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "prepared" });
        await expectRailConnectionStatus(footer, "suspended", "Suspended");

        await page.clock.install();
        await pauseVirtualClock(page);
        await gateway.setOnline(false);
        await page.clock.runFor(2_001);
        // Offline mock sockets stay connecting until their attempt explicitly fails.
        await gateway.closeLatest(1006, "synthetic failed attempt");
        await expectRailConnectionStatus(footer, "reconnecting", "Reconnecting…");
        expect(await connectionStatus.getByRole("button").count()).toBe(0);
        expect(await footer.getByText("Offline", { exact: true }).count()).toBe(0);
        await footer
          .getByRole("button", {
            name: "Identity and app menu for Riley: Reconnecting…",
            exact: true,
          })
          .click();
        expect(await sidebar.locator('[data-value="command:retry-connect"]').count()).toBe(0);
        await page.keyboard.press("Escape");

        await gateway.setOnline(true);
        await page.clock.resume();
        await expectRailConnectionStatus(footer, "suspended", "Suspended");
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
        await expect
          .poll(() => identity.getAttribute("data-connection-status"), { timeout: 10_000 })
          .toBe("connected");
        await connectionStatus.waitFor({ state: "detached" });
        expect(await announcement.textContent()).toBe("Connected");
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "prepared" });
        await gateway.emitGatewayEvent("shutdown", {
          reason: "gateway restart",
          restartExpectedMs: 5_000,
        });
        await expectRailConnectionStatus(footer, "restarting", "Restarting…");
        await expect
          .poll(() => connectionStatus.locator(".gateway-status__label").textContent())
          .toBe("Restarting…");
      },
      { ...gatewayBuild, awaitInitialRoster: false, gatewaySuspensionPhase: "prepared" },
    );
  });

  it("keeps the feature account target, identity menu, and visual states coherent", async () => {
    await withFooter(async ({ page, sidebar }) => {
      await runAccountFooterProof(page, sidebar);
    });
  });

  it("navigates from the build link without opening its hovercard", async () => {
    await withFooter(async ({ page, sidebar }) => {
      await sidebar.locator(".sidebar-identity-card").click();
      const buildLink = sidebar.getByRole("menuitem", {
        name: "Control UI build details",
        exact: true,
      });
      const tooltip = sidebar.locator("openclaw-sidebar-build-chip openclaw-tooltip");
      await tooltip.evaluate((element) => {
        document.documentElement.dataset.buildTooltipOpenedByClick = "false";
        element.addEventListener(
          "overlay-show",
          () => {
            document.documentElement.dataset.buildTooltipOpenedByClick = "true";
          },
          { once: true },
        );
      });

      await buildLink.click();

      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/about");
      expect(await page.locator("html").getAttribute("data-build-tooltip-opened-by-click")).toBe(
        "false",
      );
    });
  });
});
