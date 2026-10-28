import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { openChatPanels } from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSessionRosterHydration } from "./session-management.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI interaction surfaces" });
const key = "agent:main:surface-states";
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function background(locator: Locator, pseudo: string | null = null) {
  await locator.evaluate(finishElementAnimations);
  return locator.evaluate((element, pseudoElement) => {
    return getComputedStyle(element, pseudoElement).backgroundColor;
  }, pseudo);
}

async function frame(page: Page, label: string, target: Locator) {
  if (!capture) {
    return;
  }
  const image = await takeControlUiScreenshotFrame(page, target, [target], {
    elements: [target],
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, label + ".png"), image.png);
  await writeFile(path.join(suite.artifactDir, label + "-crop.png"), image.elements[0]!.png);
}

suite.define(() => {
  it.each(
    ["claw", "absolutely", "beacon"].flatMap((theme) =>
      (["dark", "light"] as const).map((mode) => ({ theme, mode })),
    ),
  )("preserves selection while distinguishing hover in $theme $mode", async ({ theme, mode }) => {
    await suite.withPage(
      {
        colorScheme: mode,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey: key,
          agentModel: "example/demo",
          models: [{ id: "demo", name: "Demo model", provider: "example" }],
          hasMultipleSessionSharingIdentities: true,
          sessions: [
            createControlUiSessionRow(key, "Plan the interface update", 3, {
              sharingRole: "owner",
              visibility: "shared",
              model: "demo",
              modelProvider: "example",
              owner: { actor: { type: "human", id: "operator", label: "Operator" } },
            }),
            createControlUiSessionRow("agent:main:notes", "Review project notes", 2, {
              model: "demo",
              modelProvider: "example",
            }),
            createControlUiSessionRow("agent:main:running", "Check the release plan", 1, {
              model: "demo",
              modelProvider: "example",
              status: "running",
              hasActiveRun: true,
              activeRunIds: ["run-review"],
            }),
          ],
          historyMessages: [
            { role: "user", content: "Help organize the next interface update." },
            {
              role: "assistant",
              content:
                "The plan is ready for review. Select a conversation or open Sharing to continue.",
            },
          ],
          methodResponses: { "config.get": themeConfigResponse(theme, mode) },
        });
        await seedChatSettings(page, suite.server.baseUrl, { theme, themeMode: mode });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        await waitForSessionRosterHydration(page);
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
        if (theme !== "claw") {
          await expect
            .poll(() =>
              page.evaluate(
                (family) =>
                  [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].some(
                    (link) =>
                      link.href.includes("/themes/" + family + ".css") && Boolean(link.sheet),
                  ),
                theme,
              ),
            )
            .toBe(true);
        }
        const label = theme + "-" + mode;
        const identity = page.locator(".sidebar-rail .sidebar-identity-card");
        await identity.hover();
        const railSurface = await background(identity);
        const badge = identity.locator(".sidebar-identity-card__status");
        const badgeSurface = await badge.evaluate(
          (element) => getComputedStyle(element).borderColor,
        );
        expect
          .soft(badgeSurface, "presence cutout matches the opaque hovered rail surface")
          .toBe(railSurface);
        const alpha = await identity.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data[3];
        });
        expect.soft(alpha, "rail fill remains opaque for badge masking").toBe(255);
        await frame(page, label + "-rail-badge-hover", identity);

        const row = page.locator('.sidebar-recent-session[data-session-key="' + key + '"]');
        await row.waitFor();
        for (const pinned of [false, true]) {
          const state = label + (pinned ? "-pinned" : "-recent");
          if (pinned) {
            await row.hover();
            await row.getByRole("button", { name: "Pin session", exact: true }).click();
            await page.locator('[data-session-section="pinned"]').locator(row).waitFor();
          }
          await page.mouse.move(1000, 650);
          const active = await background(row, "::after");
          await frame(page, state + "-active", row);
          await row.hover();
          const hover = await background(row, "::after");
          await frame(page, state + "-active-hover", row);
          expect.soft(hover, state + ": active hover remains distinguishable").not.toBe(active);
          await row.locator(".sidebar-recent-session__link").click({ modifiers: ["Alt"] });
          await expect
            .poll(() => row.getAttribute("class"))
            .toContain("sidebar-recent-session--selected");
          await page.mouse.move(1000, 650);
          const selected = await background(row, "::after");
          expect.soft(selected, state + ": multiselection remains distinct").not.toBe(active);
          await row.hover();
          expect
            .soft(await background(row, "::after"), state + ": hover preserves multiselection")
            .toBe(selected);
          await frame(page, state + "-selected-hover", row);
          await row.locator(".sidebar-recent-session__link").click({ modifiers: ["Alt"] });
        }
        const sharing = page.locator(
          ".chat-pane__sharing-menu--desktop > .chat-pane__sharing-trigger",
        );
        await sharing.waitFor();
        await page.mouse.move(1000, 650);
        const closed = await background(sharing);
        expect(closed).not.toBe("rgba(0, 0, 0, 0)");
        await frame(page, label + "-sharing-closed", sharing);
        await sharing.hover();
        expect.soft(await background(sharing)).not.toBe(closed);
        await sharing.click();
        await expect.poll(() => sharing.getAttribute("aria-expanded")).toBe("true");
        await page.mouse.move(1000, 650);
        const opened = await background(sharing);
        await sharing.hover();
        expect
          .soft(await background(sharing), "opened Sharing retains its surface on hover")
          .toBe(opened);
        await frame(page, label + "-sharing-open-hover", sharing);
        await page.keyboard.press("Escape");
        if (capture) {
          const composer = page.locator(".agent-chat__input");
          const composerAction = composer.locator("button:not(:disabled)").first();
          await composerAction.hover();
          await frame(page, label + "-composer-hover", composer);
          await openChatPanels(page, "desktop");
          const launcher = page.locator(".side-panel-launcher").filter({ visible: true });
          await launcher.waitFor();
          await frame(page, label + "-launcher-rest", launcher);
          const enabled = launcher
            .locator(".side-panel-launcher__card:not([aria-disabled='true'])")
            .first();
          await enabled.hover();
          await frame(page, label + "-launcher-hover", launcher);
          const disabled = launcher
            .locator(".side-panel-launcher__card[aria-disabled='true']")
            .first();
          await disabled.waitFor();
          expect(await disabled.getAttribute("aria-disabled")).toBe("true");
          await page.getByRole("button", { name: "Panel position", exact: true }).click();
          const position = page.locator(".side-panel-position__option[aria-checked='true']");
          await position.waitFor();
          await frame(
            page,
            label + "-panel-position",
            page.locator(".side-panel-position-menu").filter({ visible: true }),
          );
          await page.keyboard.press("Escape");
          await page.setViewportSize({ width: 390, height: 844 });
          await openChatPanels(page, "mobile");
          const mobile = page.locator(".chat-panel-launcher-mobile");
          await mobile.waitFor();
          await frame(page, label + "-launcher-mobile", mobile);
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.goto(suite.server.baseUrl + "settings/appearance");
          const activeSettings = page.locator(".settings-sidebar__item--active");
          await activeSettings.waitFor();
          await page.mouse.move(1000, 650);
          await frame(page, label + "-settings-selected", activeSettings);
          await activeSettings.hover();
          await frame(page, label + "-settings-selected-hover", activeSettings);
          const toggle = page.locator(".settings-toggle__input:not(:checked)").first();
          await toggle.scrollIntoViewIfNeeded();
          await frame(page, label + "-switch-off", toggle.locator(".."));
          await page.goto(suite.server.baseUrl + "activity?view=live");
          const work = page.locator(".activity-current-work__row").first();
          await work.waitFor();
          await page.mouse.move(1000, 650);
          await frame(page, label + "-activity-rest", work);
          await work.hover();
          await frame(page, label + "-activity-hover", work);
        }
        console.info(
          "Surface theme proof",
          await page.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            mode: document.documentElement.dataset.themeMode,
            text: getComputedStyle(document.body).color,
            stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
              .filter((link) => link.href.includes("/themes/"))
              .map((link) => ({ href: link.href, loaded: Boolean(link.sheet) })),
          })),
        );
      },
    );
  });
});
