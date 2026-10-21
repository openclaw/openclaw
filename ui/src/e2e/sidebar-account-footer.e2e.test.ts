import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import {
  expectAttribute,
  expectCount,
  expectExactText,
  expectPath,
} from "./sidebar-assertions.test-support.ts";
import { expectCounts, style } from "./sidebar-contract.test-support.ts";
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
  await expectAttribute(identity, "data-connection-status", kind);
  expect(await identity.isVisible()).toBe(true);
  expect(await identity.locator(".sidebar-identity-card__status").isVisible()).toBe(true);
  expect(
    await identity.evaluate((element) => ({
      label: element.getAttribute("aria-label"),
      tooltip:
        element.getAttribute("title") ||
        element.ownerDocument
          .getElementById(element.getAttribute("aria-describedby") ?? "")
          ?.textContent?.trim(),
    })),
  ).toEqual({
    label: `Identity and app menu for Riley: ${label}`,
    tooltip: `Identity and app menu for Riley: ${label}`,
  });
  await expectCounts(footer, { ".gateway-status": 0, ":scope > [role=status]": 0 });
  expect(await identity.getByRole("status").count()).toBe(0);
}

async function runAccountFooterProof(page: Page, sidebar: Locator) {
  const identity = sidebar.locator(".sidebar-identity-card");

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
    expect(await style(settingsShortcut, "font-family")).toMatch(/^system-ui,/u);
    const settingsRestBackground = await style(settings, "background-color");
    await settings.hover();
    await expect.poll(() => settings.evaluate((element) => element.matches(":hover"))).toBe(true);
    await expect.poll(() => style(settings, "background-color")).not.toBe(settingsRestBackground);

    const help = menu.locator('[data-value="command:help"]');
    await help.hover();
    const submenu = help.locator("..").locator('[role="menu"]');
    await submenu.waitFor({ state: "visible" });

    await page.keyboard.press("Escape");
    await submenu.waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await expectCount(menu, 0);
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
  it("gates release-update notifications and opens settings without running an update", async () => {
    const channel = "stable";
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
        await expectCount(badge, 1);
        await expectCount(sidebar.locator(".sidebar-issues-button__count"), 1);
        // The selected schedule wins over leftover availability from another channel.
        await gateway.emitGatewayEvent("update.available", {
          updateAvailable,
          schedule: { ...updateSchedule, channel: "dev" },
        });
        await expectCount(badge, 0);
        await expectCount(sidebar.locator(".sidebar-issues-button__count"), 0);
        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: { ...updateAvailable, channel: "beta" },
          schedule: { ...updateSchedule, channel: "beta" },
        });
        await expectCount(badge, 1);
        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: { channel: "beta", currentVersion: "2.0.0", latestVersion: "2.0.0" },
          schedule: { channel: "beta", autoEnabled: false },
        });
        await expectCount(badge, 0);
        await updates.click();
        await expectPath(page, "/settings/updates");
        await expectCount(menu, 0);
        await page.getByRole("heading", { name: "Updates", exact: true }).waitFor();
        await gateway.waitForRequest("update.status");
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await page.getByRole("button", { name: "Back to app", exact: true }).click();
        await expectPath(page, "/chat/main");
      },
      {
        ...gatewayBuild,
        operatorScopes: ["operator.read", "operator.admin"],
        updateAvailable,
        updateSchedule,
      },
    );
  });

  it("labels the lifecycle status on the account icon during automatic recovery", async () => {
    await withFooter(
      async ({ gateway, page, sidebar }) => {
        const footer = sidebar.locator(".sidebar-footer-bar");
        const identity = footer.locator(".sidebar-identity-card");
        const connectionStatus = page.locator(".sidebar-shell__footer .gateway-status:visible");
        const connectionLabel = connectionStatus.locator(".gateway-status__label");
        const announcement = page.locator(".shell > .sr-only[role=status]");
        await setSidebarProofTheme(page, "dark");
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await waitForControlUiGatewayReady(page);
        await expectRailConnectionStatus(footer, "suspended", "Suspended");
        await expectExactText(connectionLabel, "Suspended");
        const inbox = footer.locator("openclaw-sidebar-attention");
        expect(await inbox.getByRole("status").count()).toBe(1);
        expect(await inbox.getByRole("status").textContent()).toBe(
          await inbox.locator(".sidebar-issues-button").getAttribute("aria-label"),
        );
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
        await expectAttribute(identity, "data-connection-status", "connected");
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
          await expectExactText(connectionLabel, label);
          expect(await announcement.textContent()).toBe(label);
        }
        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar.locator('[data-value="command:settings"]').click();
        const settingsFooter = page.locator(".settings-sidebar__footer");
        await settingsFooter.waitFor();
        await expectCounts(settingsFooter, {
          ".gateway-status": 1,
          "openclaw-settings-save-indicator": 1,
        });
        await expectExactText(connectionLabel, "Suspended");
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
        await expectExactText(connectionLabel, "Restarting…");
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

      await expectPath(page, "/settings/about");
      expect(await page.locator("html").getAttribute("data-build-tooltip-opened-by-click")).toBe(
        "false",
      );
    });
  });
});
