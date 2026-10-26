import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createConfigSuite } from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Settings secret reveal keyboard focus");
const indicator = (control: Locator) =>
  control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      outlineColor: style.outlineColor,
      shadow: style.boxShadow,
      border: style.border,
    };
  });

suite.define(() => {
  it("keeps reveal and hide keyboard focus visible without changing ordinary themes", async () => {
    await suite.withPage(
      { forcedColors: "active", reducedMotion: "reduce", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { authMode: "token" });
        await page.goto(suite.server.baseUrl + "settings/connection");
        const secret = page.getByLabel("Gateway secret", { exact: true });
        await secret.waitFor();
        await secret.fill("synthetic-keyboard-proof");
        const toggle = page.locator(".settings-secret__toggle");
        const resting = await indicator(toggle);
        await secret.press("Tab");
        expect(
          await toggle.evaluate(
            (element) => element === document.activeElement && element.matches(":focus-visible"),
          ),
        ).toBe(true);
        const focused = await indicator(toggle);
        expect(focused).toMatchObject({
          outlineStyle: "solid",
          outlineWidth: "2px",
          outlineOffset: "2px",
          shadow: "none",
        });
        expect(focused).not.toEqual(resting);
        expect(await secret.getAttribute("type")).toBe("password");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const section = page.locator("openclaw-connection-page .settings-section").first();
          const frame = await takeControlUiScreenshotFrame(page, section, [secret, toggle], {
            animations: "disabled",
            elements: [section],
          });
          await writeFile(path.join(suite.artifactDir, "after-focused.png"), frame.png);
          await writeFile(
            path.join(suite.artifactDir, "after-section.png"),
            frame.elements[0]!.png,
          );
          console.log("Secret focus proof", suite.artifactDir, focused);
        }
        await toggle.press("Space");
        await expect.poll(() => secret.getAttribute("type")).toBe("text");
        expect(await toggle.getAttribute("aria-pressed")).toBe("true");
        expect(await indicator(toggle)).toEqual(focused);
        await toggle.press("Space");
        await expect.poll(() => secret.getAttribute("type")).toBe("password");
        expect(await secret.inputValue()).toBe("synthetic-keyboard-proof");
        await toggle.press("Tab");
        expect(await indicator(toggle)).toEqual(resting);
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ forcedColors: "none", colorScheme });
          await secret.press("Tab");
          const ordinary = await indicator(toggle);
          expect(ordinary.outlineStyle).toBe("none");
          expect(ordinary.shadow).not.toBe("none");
          await toggle.press("Tab");
        }
        expect(await gateway.getRequests("config.set")).toEqual([]);
      },
    );
  });
});
