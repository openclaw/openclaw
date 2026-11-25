import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { SessionBackground } from "../components/session-background-host.tsx";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal background first-paint readiness" });

const backgroundOf = (page: Page) => page.locator("openclaw-session-background").first();
const backgroundKind = (element: Locator) =>
  element.evaluate(
    (node) => (node as SessionBackground).context?.theme.settings.background?.source.kind,
  );

const preferences = (entries: Record<string, unknown>) => ({ status: "ok", entries });

function installPreferences(page: Page) {
  return installMockGateway(page, {
    presenceUsers: [{ id: "background-viewer", name: "Background demo", self: true }],
    deferredMethods: ["users.prefs.get"],
    featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get"],
    methodResponses: {
      "config.get": configResponse({ theme: "dash", themeMode: "dark" }, "background"),
    },
  });
}

suite.define(() => {
  it.each(["none", "absent"] as const)(
    "waits for the saved %s choice before any initial shell image request",
    (choice) =>
      suite.withPage(
        { colorScheme: "dark", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const entries =
            choice === "none"
              ? {
                  "ui.background": selectBackgroundSource({ kind: "none" }),
                  "ui.themeMode": "light",
                }
              : { "ui.themeMode": "light" };
          const gateway = await installPreferences(page);
          const imageRequests: string[] = [];
          page.on("request", (request) => {
            const pathname = new URL(request.url()).pathname;
            if (
              pathname.includes("/__openclaw__/users/background/") ||
              /(?:claw|knot|dash|absolutely|tide|beacon|phosphor|crt|manuscript|rose|miami|custom)-(?:dark|light).*\.webp$/u.test(
                pathname,
              )
            ) {
              imageRequests.push(request.url());
            }
          });
          // Cover both cold startup and the saved mirror without seeding root attributes.
          for (const reload of [false, true]) {
            imageRequests.length = 0;
            await (reload ? page.reload() : page.goto(suite.server.baseUrl + "new"));
            await gateway.waitForRequest("users.prefs.get");
            const shell = page.locator(".shell");
            await shell.waitFor({ state: "visible" });
            const shellImage = () =>
              shell.evaluate((element) => getComputedStyle(element).backgroundImage);
            expect(await shellImage()).toBe("none");
            expect(imageRequests).toEqual([]);
            await gateway.resolveDeferred("users.prefs.get", preferences(entries));
            await expect
              .poll(() => page.locator("html").getAttribute("data-theme"))
              .toBe("dash-light");
            if (choice === "none") {
              await expect.poll(() => backgroundKind(backgroundOf(page))).toBe("none");
            }
            if (choice === "absent" && !reload && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              const frame = await takeControlUiScreenshotFrame(
                page,
                shell,
                [page.locator(".agent-chat__input")],
                { animations: "disabled" },
              );
              await writeFile(path.join(suite.artifactDir, "new-session.png"), frame.png);
            }
            expect(await shellImage()).toBe("none");
            expect(await page.locator(".session-background__image").count()).toBe(0);
            expect(imageRequests).toEqual([]);
          }
        },
      ),
  );
});
