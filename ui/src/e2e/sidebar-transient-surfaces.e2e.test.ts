import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiSettingsTakeover } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openPicker } from "../test-helpers/select-picker-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { createSidebarCustomizationSuite } from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite(
  "Control UI transient surface tokens mocked Gateway E2E",
);

const themes = [
  { colorScheme: "light", resolvedTheme: "light", theme: "claw" },
  { colorScheme: "dark", resolvedTheme: "dark", theme: "claw" },
  { colorScheme: "light", resolvedTheme: "openknot-light", theme: "knot" },
  { colorScheme: "dark", resolvedTheme: "openknot", theme: "knot" },
  { colorScheme: "light", resolvedTheme: "dash-light", theme: "dash" },
  { colorScheme: "dark", resolvedTheme: "dash", theme: "dash" },
] as const;

async function surfaceTokens(surface: Locator) {
  return surface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
}

suite.define(() => {
  it.each(themes)(
    "uses one transient surface contract in $theme $colorScheme",
    ({ colorScheme, resolvedTheme, theme }) =>
      suite.withPage(
        { colorScheme, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          const sessionKey = "agent:main:release-notes";
          await installMockGateway(page, {
            featureMethods: ["sessions.patch"],
            methodResponses: {
              "config.get": configResponse(
                { locale: "en", theme, themeMode: colorScheme },
                `transient-surfaces-${theme}-${colorScheme}`,
              ),
              "sessions.list": sessionsListResponse([
                sessionRow(sessionKey, "Release notes", Date.parse("2026-08-14T15:59:00.000Z")),
              ]),
            },
            sessionKey,
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const root = page.locator("html");
          await expect.poll(() => root.getAttribute("data-theme")).toBe(resolvedTheme);

          const session = page.locator(`openclaw-app-sidebar [data-session-key="${sessionKey}"]`);
          await session.waitFor();
          await session.hover();
          await session.click({ button: "right" });
          const menuSurface = page.getByRole("menu", {
            name: "Actions for Release notes",
            exact: true,
          });
          await menuSurface.waitFor({ state: "visible" });
          const menuTokens = await surfaceTokens(menuSurface);
          await evaluateControlUiContext(page, (context) => context.navigate("appearance"));
          await waitForControlUiSettingsTakeover(page);
          await expect.poll(() => root.getAttribute("data-theme")).toBe(resolvedTheme);
          const languageSelect = page.locator("#settings-language openclaw-select-picker");
          await openPicker(languageSelect);
          const listbox = languageSelect.locator(".picker-select__menu");
          await listbox.waitFor({ state: "visible" });

          expect(await surfaceTokens(listbox)).toEqual(menuTokens);
        },
      ),
  );
});
