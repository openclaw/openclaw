import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createThemedChatOpener } from "./theme-typography.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Terminal theme branding" });
const openThemedPage = createThemedChatOpener(suite);
suite.define(() => {
  it.each([
    { theme: "crt", mode: "dark" as const },
    { theme: "crt", mode: "light" as const },
    { theme: "phosphor", mode: "dark" as const },
    { theme: "phosphor", mode: "light" as const },
  ])("uses terminal branding for $theme in $mode mode", async ({ theme, mode }) => {
    const { page, gateway } = await openThemedPage(theme, mode);
    await page.goto(suite.server.baseUrl + "settings/about");
    const hero = page.locator(".about-hero");
    await hero.locator(".about-hero__mark--neutral svg").waitFor();
    expect(await hero.locator(".about-hero__clawd").count()).toBe(0);
    expect(await hero.locator(".about-hero__name").textContent()).toBe("OpenClaw");
    await hero.getByRole("link", { name: "Docs", exact: true }).waitFor();
    expect(await page.locator("html").getAttribute("data-theme-id")).toBe(theme);
    expect(await page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && mode === "dark") {
      const frame = await takeControlUiScreenshotFrame(page, page.locator("openclaw-app"), [hero], {
        animations: "disabled",
      });
      writeFileSync(path.join(suite.artifactDir, theme + "-after.png"), frame.png);
    }
    await page.goto(suite.server.baseUrl + "settings/appearance");
    await page.locator(".settings-tab-icon").waitFor();
    expect(await page.locator(".lobsterdex__gallery").count()).toBe(0);
    expect(
      await page.locator(".settings-tab-icon").getByText("Lobsterdex", { exact: true }).count(),
    ).toBe(0);
    await page.goto(suite.server.baseUrl + "chat");
    await page
      .locator(".agent-chat__composer-combobox textarea")
      .fill("Check the terminal workspace.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await gateway.waitForRequest("chat.send");
    const indicator = page.locator(".chat-reading-indicator--neutral");
    await indicator.waitFor();
    expect(await indicator.locator(":scope > span").count()).toBe(3);
    expect(await indicator.locator("svg").count()).toBe(0);
  });
});
