import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Shell presentation continuity" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const variants = [
  { width: 1440, height: 900, colorScheme: "light" },
  { width: 1440, height: 900, colorScheme: "dark" },
  { width: 390, height: 844, colorScheme: "light" },
  { width: 390, height: 844, colorScheme: "dark" },
] as const;

async function saveFrame(page: Page, name: string, content: Locator[]): Promise<void> {
  if (!capture) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, page.locator("openclaw-app"), content, {
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
}

suite.define(() => {
  it.each(variants)(
    "keeps one sidebar and the active draft through $width px $colorScheme shell states",
    async ({ width, height, colorScheme }) => {
      await suite.withPage(
        {
          viewport: { width, height },
          colorScheme,
          locale: "en-US",
          reducedMotion: "reduce",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [
              { role: "assistant", content: "A synthetic conversation for shell presentation." },
            ],
          });
          await page.addInitScript(
            ({ gatewayUrl, mode }) => {
              localStorage.setItem(
                `openclaw.control.settings.v1:${gatewayUrl}`,
                JSON.stringify({ gatewayUrl, theme: "claw", themeMode: mode }),
              );
            },
            { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), mode: colorScheme },
          );
          await page.goto(`${suite.server.baseUrl}new`);
          await waitForControlUiRoute(page, { routeId: "new-session" });
          const shell = page.locator(".shell");
          const sidebar = page.locator("openclaw-app-sidebar");
          expect(await sidebar.count()).toBe(1);
          const sidebarNode = await sidebar.elementHandle();
          expect(sidebarNode).not.toBeNull();
          const assertSidebarIdentity = async () => {
            expect(await sidebar.count()).toBe(1);
            expect(
              await page.evaluate(
                (original) => document.querySelector("openclaw-app-sidebar") === original,
                sidebarNode,
              ),
            ).toBe(true);
          };
          const prefix = `${width}-${colorScheme}`;
          await saveFrame(page, `${prefix}-navigation-initial`, [shell]);
          await page
            .locator(
              '.topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible, [data-navigation-view][aria-pressed="true"]:visible',
            )
            .first()
            .click();
          if (width < 900) {
            await page.locator(".shell--nav-drawer-open").waitFor();
            await saveFrame(page, `${prefix}-drawer-open`, [shell, sidebar.locator(".sidebar")]);
            await page.keyboard.press("Escape");
            await expect
              .poll(() => shell.getAttribute("class"))
              .not.toContain("shell--nav-drawer-open");
          } else {
            await page.locator(".shell--nav-collapsed").waitFor();
            await saveFrame(page, `${prefix}-sidebar-collapsed`, [shell]);
            await page.locator(".shell-chrome-controls__nav-toggle:visible").click();
            await expect
              .poll(() => shell.getAttribute("class"))
              .not.toContain("shell--nav-collapsed");
          }
          await assertSidebarIdentity();
          await saveFrame(page, `${prefix}-navigation-restored`, [shell]);

          await page.evaluate(() => window.openclawControlUi?.navigate("chat"));
          await waitForControlUiRoute(page, { routeId: "chat" });
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill("Keep this synthetic draft through connection recovery.");
          await assertSidebarIdentity();
          const connectCount = (await gateway.getRequests("connect")).length;
          await gateway.deferNext("connect");
          await gateway.setOnline(false);
          await page.locator(".agent-chat__input--offline").waitFor();
          expect(await composer.inputValue()).toBe(
            "Keep this synthetic draft through connection recovery.",
          );
          await saveFrame(page, `${prefix}-offline`, [shell, composer]);
          await gateway.setOnline(true);
          await gateway.waitForRequest("connect", { after: connectCount });
          await page.waitForFunction(
            () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
          );
          await saveFrame(page, `${prefix}-reconnecting`, [shell, composer]);
          await gateway.resolveDeferred("connect");
          await page.waitForFunction(() => {
            const state = window.openclawControlUi?.snapshot();
            return state?.gatewayPhase === "connected" && state.ready;
          });
          expect(await composer.inputValue()).toBe(
            "Keep this synthetic draft through connection recovery.",
          );
          await assertSidebarIdentity();
          await saveFrame(page, `${prefix}-connected`, [shell, composer]);
          await sidebarNode?.dispose();

          await page.goto(`${suite.server.baseUrl}new?onboarding=1`);
          await page.locator(".shell--onboarding").waitFor();
          await waitForControlUiRoute(page, { routeId: "new-session" });
          expect(await page.locator(".shell-nav:visible").count()).toBe(0);
          await saveFrame(page, `${prefix}-onboarding`, [page.locator(".shell--onboarding")]);
          if (capture) {
            await writeFile(
              path.join(suite.artifactDir, `${prefix}-summary.json`),
              `${JSON.stringify({ width, height, colorScheme, sidebarIdentityPreserved: true, draftPreserved: true, finalPresentation: "onboarding" }, null, 2)}\n`,
            );
          }
        },
      );
    },
  );
});
